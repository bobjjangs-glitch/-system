package com.bobjjang.bareundispatch;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;

/** Exercises the actual generated native module's cross-thread settlement gate. */
public class DispatchReceiptOcrGateTest {
  @Test public void oneReceiptOwnsTheRecognizerUntilSettlement() {
    DispatchReceiptOcrGate<Object> gate = new DispatchReceiptOcrGate<>();
    Object first = new Object(), second = new Object();
    assertTrue(gate.begin(first));
    assertFalse(gate.begin(second));
    assertTrue(gate.take(first));
    assertTrue(gate.begin(second));
    assertFalse(gate.take(first));
    assertTrue(gate.isCurrent(second));
  }

  @Test public void cancelledCompletionCannotSettleTheNextReceipt() {
    DispatchReceiptOcrGate<Object> gate = new DispatchReceiptOcrGate<>();
    Object first = new Object(), next = new Object();
    assertTrue(gate.begin(first));
    assertSame(first, gate.cancel());
    assertTrue(gate.begin(next));
    assertFalse(gate.take(first));
    assertTrue(gate.isCurrent(next));
  }

  @Test public void invalidationRejectsFutureReceiptStarts() {
    DispatchReceiptOcrGate<Object> gate = new DispatchReceiptOcrGate<>();
    Object first = new Object();
    assertTrue(gate.begin(first));
    assertSame(first, gate.close());
    assertFalse(gate.begin(new Object()));
    assertFalse(gate.take(first));
  }

  @Test public void timeoutAndNativeCallbackRaceHasOnlyOneWinner() throws Exception {
    DispatchReceiptOcrGate<Object> gate = new DispatchReceiptOcrGate<>();
    Object receipt = new Object();
    assertTrue(gate.begin(receipt));
    CountDownLatch start = new CountDownLatch(1);
    AtomicInteger winners = new AtomicInteger();
    List<Thread> threads = new ArrayList<>();
    for (int i = 0; i < 20; i++) {
      Thread thread = new Thread(() -> {
        try { start.await(); } catch (InterruptedException e) { throw new AssertionError(e); }
        if (gate.take(receipt)) winners.incrementAndGet();
      });
      threads.add(thread);
      thread.start();
    }
    start.countDown();
    for (Thread thread : threads) thread.join(1000);
    assertEquals(1, winners.get());
    assertTrue(gate.begin(new Object()));
  }

  @Test public void decodeSamplingBoundsMemoryAndKeepsSmallImagesUnscaled() {
    assertEquals(1, DispatchReceiptOcrModule.sampleSize(800, 600));
    assertEquals(2, DispatchReceiptOcrModule.sampleSize(4000, 3000));
    assertEquals(4, DispatchReceiptOcrModule.sampleSize(8176, 6144));
    assertEquals(4, DispatchReceiptOcrModule.sampleSize(6144, 8176));
    assertTrue(DispatchReceiptOcrModule.TIMEOUT_MS < 5000);
  }
}
