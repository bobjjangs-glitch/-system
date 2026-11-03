package com.bobjjang.bareundispatch;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;

/** Exercises the actual generated native module's settlement and bounded layout helpers. */
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

  @Test public void layoutBoxesUseUprightImageDimensionsAndClipEdges() {
    assertArrayEquals(new double[] {0.1, 0.1, 0.4, 0.2},
      DispatchReceiptOcrModule.normalizedBox(100, 50, 500, 150, 1000, 500), 0.000001);
    // An EXIF-rotated portrait uses its final width/height, just like its saved preview.
    assertArrayEquals(new double[] {0.1, 0.1, 0.4, 0.2},
      DispatchReceiptOcrModule.normalizedBox(60, 100, 300, 300, 600, 1000), 0.000001);
    assertArrayEquals(new double[] {0, 0.9, 1, 0.1},
      DispatchReceiptOcrModule.normalizedBox(-20, 450, 1200, 600, 1000, 500), 0.000001);
    assertNull(DispatchReceiptOcrModule.normalizedBox(1100, 0, 1200, 40, 1000, 500));
    assertNull(DispatchReceiptOcrModule.normalizedBox(50, 50, 10, 100, 1000, 500));
    assertNull(DispatchReceiptOcrModule.normalizedBox(0, 0, 10, 10, 0, 500));
  }

  @Test public void layoutWordLimitsResetPerLineAndKeepATotalBound() {
    DispatchReceiptOcrModule.LayoutBudget budget = new DispatchReceiptOcrModule.LayoutBudget();
    int accepted = 0;
    for (int row = 0; row < 134; row++) {
      assertNotNull(budget.lineText("r"));
      assertNull(budget.elementText(" "));
      for (int word = 0; word < 30; word++) {
        if (budget.elementText("w") != null) accepted++;
      }
      assertNull(budget.elementText("overflow"));
    }
    assertEquals(4000, accepted);
    assertNotNull(budget.lineText("next"));
    assertNull(budget.elementText("over global limit"));
  }

  @Test public void layoutCapsNoisyLinesAndDuplicateBridgeText() {
    DispatchReceiptOcrModule.LayoutBudget lines = new DispatchReceiptOcrModule.LayoutBudget();
    for (int i = 0; i < 1000; i++) assertNotNull(lines.lineText("row"));
    assertNull(lines.lineText("extra row"));

    DispatchReceiptOcrModule.LayoutBudget text = new DispatchReceiptOcrModule.LayoutBudget();
    assertEquals(50000, text.lineText("x".repeat(50001)).length());
    assertNull(text.elementText("duplicate"));
    assertNull(text.lineText("extra text"));
  }
}
