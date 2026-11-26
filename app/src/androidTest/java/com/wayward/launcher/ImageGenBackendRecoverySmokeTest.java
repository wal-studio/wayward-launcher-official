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

            ImageGenService.serverReady = false;
            ImageGenService.serverAvailable = false;
            ImageGenService.starting = false;
            ImageGenService.statusMessage = null;
            Intent start = new Intent(context, ImageGenService.class)
                    .setAction(ImageGenService.ACTION_START)
                    .putExtra(ImageGenService.EXTRA_BACKEND_ROOT, installed.getAbsolutePath())
                    .putExtra(ImageGenService.EXTRA_BACKEND_VERSION, "0.8.4")
                    .putExtra(ImageGenService.EXTRA_LAUNCH_MODE, "novelai");
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(start);
            else context.startService(start);

            long deadline = android.os.SystemClock.elapsedRealtime() + 240_000L;
            while (android.os.SystemClock.elapsedRealtime() < deadline
                    && !ImageGenService.serverAvailable
                    && (ImageGenService.statusMessage == null || ImageGenService.starting)) {
                android.os.SystemClock.sleep(500);
            }
            assertTrue("ImageGen 0.8.4 server must answer /api/image/health; status="
                    + ImageGenService.statusMessage, ImageGenService.serverAvailable);
            assertNotNull("backend health probe must publish a status", ImageGenService.statusMessage);
        } finally {
            try { context.startService(stop); } catch (Exception ignored) {}
            long stopDeadline = android.os.SystemClock.elapsedRealtime() + 15_000L;
            while (android.os.SystemClock.elapsedRealtime() < stopDeadline
                    && (ImageGenService.serverAvailable || ImageGenService.starting)) {
                android.os.SystemClock.sleep(250);
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
