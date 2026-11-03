package com.bobjjang.bareundispatch;

import android.app.Application;
import android.app.Notification;
import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import expo.modules.interfaces.taskManager.TaskInterface;
import expo.modules.location.AppForegroundedSingleton;
import expo.modules.location.services.LocationTaskService;
import expo.modules.location.taskConsumers.LocationTaskConsumer;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowService;
import static org.junit.Assert.*;

/** Exercises the actual patched SDK service and bind callbacks on Android 14/15. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {34, 35}, application = Application.class, shadows = LocationTaskServiceTest.ServiceShadow.class)
public class LocationTaskServiceTest {
  private static final String TASK = "bareun-dispatch-background-location-v2";

  @Implements(Service.class)
  public static class ServiceShadow extends ShadowService {
    static boolean reject;
    @Implementation
    public void startForeground(int id, Notification notification) throws Exception {
      if (reject) throw new SecurityException("Simulated while-in-use location restriction");
      super.startForeground(id, notification);
    }
  }

  @Before public void reset() {
    ServiceShadow.reject = false;
    LocationTaskService.Companion.updateStatus(TASK, "stopped");
    AppForegroundedSingleton.INSTANCE.setForegrounded(true);
  }

  private Intent startIntent() {
    Bundle options = new Bundle();
    options.putString("notificationTitle", "배송 중");
    options.putString("notificationBody", "위치를 공유합니다.");
    options.putString("notificationColor", "#153b36");
    return new Intent(RuntimeEnvironment.getApplication(), LocationTaskService.class)
      .putExtra("appId", "dispatch-test")
      .putExtra("taskName", TASK)
      .putExtra(LocationTaskService.SERVICE_OPTIONS_KEY, options);
  }

  @Test public void promotesWithoutWaitingForBinding() {
    LocationTaskService service = Robolectric.buildService(LocationTaskService.class).create().get();
    assertEquals(Service.START_NOT_STICKY, service.onStartCommand(startIntent(), 0, 1));
    assertEquals("running", LocationTaskService.Companion.getStatus(TASK));
    // No bind callback was invoked: promotion must already have happened.
    service.stop();
    assertEquals("stopped", LocationTaskService.Companion.getStatus(TASK));
  }

  @Test public void permissionRejectionDoesNotEscapeAndroidMainThread() {
    LocationTaskService service = Robolectric.buildService(LocationTaskService.class).create().get();
    ServiceShadow.reject = true;
    service.onStartCommand(startIntent(), 0, 1);
    assertEquals("failed:SecurityException", LocationTaskService.Companion.getStatus(TASK));
    service.onDestroy();
    assertEquals("failed:SecurityException", LocationTaskService.Companion.getStatus(TASK));
    assertTrue(new java.io.File(service.getFilesDir(), "dispatch-native-crash.txt").exists());
  }

  @Test public void emptyRestartIntentStopsWithoutCrashOrReplay() {
    LocationTaskService service = Robolectric.buildService(LocationTaskService.class).create().get();
    assertEquals(Service.START_NOT_STICKY, service.onStartCommand(null, 0, 1));
    assertNotEquals("running", LocationTaskService.Companion.getStatus(TASK));
  }

  private static class BindingContext extends ContextWrapper {
    ServiceConnection connection;
    int unbinds, stops;
    boolean rejectBind, rejectStart;
    BindingContext() { super(RuntimeEnvironment.getApplication()); }
    @Override public ComponentName startForegroundService(Intent intent) {
      if (rejectStart) throw new SecurityException("Simulated denied start");
      return new ComponentName(this, LocationTaskService.class);
    }
    @Override public boolean bindService(Intent intent, ServiceConnection callback, int flags) {
      connection = callback;
      return !rejectBind;
    }
    @Override public void unbindService(ServiceConnection callback) { unbinds++; }
    @Override public boolean stopService(Intent intent) { stops++; return true; }
  }

  private LocationTaskConsumer consumer(BindingContext context) throws Exception {
    LocationTaskConsumer consumer = new LocationTaskConsumer(context, null);
    Map<String, Object> options = new HashMap<>();
    options.put("foregroundService", new HashMap<String, Object>());
    TaskInterface task = (TaskInterface) Proxy.newProxyInstance(
      TaskInterface.class.getClassLoader(), new Class<?>[]{TaskInterface.class},
      (proxy, method, args) -> {
        switch (method.getName()) {
          case "getName": return TASK;
          case "getAppScopeKey": return "dispatch-test";
          case "getOptions": return options;
          default: return null;
        }
      });
    Field field = LocationTaskConsumer.class.getDeclaredField("mTask");
    field.setAccessible(true);
    field.set(consumer, task);
    return consumer;
  }

  private void start(LocationTaskConsumer consumer) throws Exception {
    Method method = LocationTaskConsumer.class.getDeclaredMethod("maybeStartForegroundService");
    method.setAccessible(true);
    method.invoke(consumer);
  }

  @Test public void stoppedConsumerIgnoresDelayedBindingAndReleasesConnection() throws Exception {
    BindingContext context = new BindingContext();
    LocationTaskConsumer consumer = consumer(context);
    start(consumer);
    ServiceConnection delayed = context.connection;
    assertNotNull(delayed);
    assertEquals("starting", LocationTaskService.Companion.getStatus(TASK));
    consumer.didUnregister();
    assertEquals(1, context.unbinds);
    assertEquals(1, context.stops);
    LocationTaskService service = Robolectric.buildService(LocationTaskService.class).create().get();
    delayed.onServiceConnected(new ComponentName(context, LocationTaskService.class), service.new ServiceBinder());
    assertEquals("stopped", LocationTaskService.Companion.getStatus(TASK));
    Field field = LocationTaskConsumer.class.getDeclaredField("mService");
    field.setAccessible(true);
    assertNull(field.get(consumer));
  }

  @Test public void rejectedBindingCleansUpStartedService() throws Exception {
    BindingContext context = new BindingContext();
    context.rejectBind = true;
    InvocationTargetException error = assertThrows(InvocationTargetException.class, () -> start(consumer(context)));
    assertTrue(error.getCause() instanceof IllegalStateException);
    assertEquals(1, context.stops);
    assertEquals("failed:IllegalStateException", LocationTaskService.Companion.getStatus(TASK));
  }

  @Test public void deniedStartRemainsCatchableByTheNativePromise() throws Exception {
    BindingContext context = new BindingContext();
    context.rejectStart = true;
    InvocationTargetException error = assertThrows(InvocationTargetException.class, () -> start(consumer(context)));
    assertTrue(error.getCause() instanceof SecurityException);
    assertEquals("failed:SecurityException", LocationTaskService.Companion.getStatus(TASK));
  }
}
