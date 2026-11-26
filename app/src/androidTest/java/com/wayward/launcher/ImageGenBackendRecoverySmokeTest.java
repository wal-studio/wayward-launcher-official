package com.wayward.launcher;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

@RunWith(AndroidJUnit4.class)
public final class ImageGenBackendRecoverySmokeTest {
    @Test
    public void bundled084BackendInstallsAndRunsNovelAiHealthEndpoint() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File backend = new File(context.getFilesDir(), "imagegen/recovery-smoke-" + System.nanoTime());
        Intent stop = new Intent(context, ImageGenService.class).setAction(ImageGenService.ACTION_STOP);
        try {
            context.stopService(new Intent(context, ImageGenService.class));
            android.os.SystemClock.sleep(500);
            File installed = ImageGenBackendInstaller.install(context, backend);
            assertNotNull(installed);
            assertTrue("restored 0.8.4 backend must pass installer manifest/hash validation",
                    ImageGenBackendInstaller.isValidInstalled(installed));

            ImageGenStatusStore.State beforeStart = ImageGenStatusStore.read(context.getFilesDir());
            assertTrue("previous ImageGen service must be stopped before recovery test",
                    !beforeStart.isStarting() && !beforeStart.isAvailable());
            Intent start = new Intent(context, ImageGenService.class)
                    .setAction(ImageGenService.ACTION_START)
                    .putExtra(ImageGenService.EXTRA_BACKEND_ROOT, installed.getAbsolutePath())
                    .putExtra(ImageGenService.EXTRA_BACKEND_VERSION, "0.8.4")
                    .putExtra(ImageGenService.EXTRA_LAUNCH_MODE, "novelai");
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(start);
            else context.startService(start);

            long deadline = android.os.SystemClock.elapsedRealtime() + 240_000L;
            ImageGenStatusStore.State state = ImageGenStatusStore.read(context.getFilesDir());
            while (android.os.SystemClock.elapsedRealtime() < deadline
                    && !state.isAvailable()
                    && (state.message.isEmpty() || state.isStarting())) {
                android.os.SystemClock.sleep(500);
                state = ImageGenStatusStore.read(context.getFilesDir());
            }
            assertTrue("ImageGen 0.8.4 server must answer /api/image/health; status="
                    + state.message, state.isAvailable());
            assertTrue("backend health probe must publish a fresh cross-process status",
                    state.isFresh() && !state.message.isEmpty());
        } finally {
            try { context.startService(stop); } catch (Exception ignored) {}
            long stopDeadline = android.os.SystemClock.elapsedRealtime() + 15_000L;
            ImageGenStatusStore.State stopped = ImageGenStatusStore.read(context.getFilesDir());
            while (android.os.SystemClock.elapsedRealtime() < stopDeadline
                    && (stopped.isAvailable() || stopped.isStarting())) {
                android.os.SystemClock.sleep(250);
                stopped = ImageGenStatusStore.read(context.getFilesDir());
            }
            deleteTree(backend);
        }
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        file.delete();
    }
}
