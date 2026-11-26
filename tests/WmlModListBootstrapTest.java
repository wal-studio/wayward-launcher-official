package com.wayward.launcher;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

public final class WmlModListBootstrapTest {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        String quote = String.valueOf((char) 34);
        String fixture = "/* WML mod list */\nWML.enable([\n"
                + "  " + quote + "addon-compat" + quote + ",\n"
                + "  " + quote + "imagestudio:off" + quote + ", // keep this state\n"
                + "]);\n";
        String patched = WmlModListBootstrap.ensureCloudSaveEnabled(fixture);
        check(WmlModListBootstrap.hasCloudSaveEntry(patched), "CloudSave must be added to the enable list");
        check(patched.contains(quote + "addon-compat" + quote), "existing enabled mods must be preserved");
        check(patched.contains(quote + "imagestudio:off" + quote), "existing disabled mods must be preserved");
        check(WmlModListBootstrap.ensureCloudSaveEnabled(patched).equals(patched),
                "repeated interception must not duplicate CloudSave");

        String alreadyEnabled = "WML.enable(['cloud-save', 'addon-compat']);";
        check(WmlModListBootstrap.ensureCloudSaveEnabled(alreadyEnabled).equals(alreadyEnabled),
                "an existing enabled entry must not be duplicated");

        String explicitlyDisabled = "WML.enable(['cloud-save:off', 'addon-compat']);";
        check(WmlModListBootstrap.ensureCloudSaveEnabled(explicitlyDisabled).equals(explicitlyDisabled),
                "an explicit user opt-out must be preserved");

        String commentedEntry = "WML.enable([\n  // 'cloud-save',\n  'addon-compat'\n]);";
        String uncommented = WmlModListBootstrap.ensureCloudSaveEnabled(commentedEntry);
        check(WmlModListBootstrap.hasCloudSaveEntry(uncommented),
                "a commented-out example must not suppress the default entry");
        check(WmlModListBootstrap.ensureCloudSaveEnabled(uncommented).equals(uncommented),
                "the inserted entry must remain idempotent");

        String nested = "WML.enable(['addon-compat', { nested: ['not-an-id'] }]);";
        String nestedPatched = WmlModListBootstrap.ensureCloudSaveEnabled(nested);
        check(WmlModListBootstrap.hasCloudSaveEntry(nestedPatched),
                "nested brackets must not truncate the WML enable list");

        String commentedCall = "// WML.enable(['wrong']);\nconst label = 'WML.enable([no])';";
        check(WmlModListBootstrap.ensureCloudSaveEnabled(commentedCall).equals(commentedCall),
                "comments and strings must not be mistaken for the WML enable call");

        String unrelated = "console.log('no WML list');";
        check(WmlModListBootstrap.ensureCloudSaveEnabled(unrelated).equals(unrelated),
                "unrelated source must remain unchanged");

        if (args.length > 0) verifyArchive(args[0]);
        System.out.println("WML CloudSave enable-list bootstrap tests passed");
    }

    private static void verifyArchive(String path) throws Exception {
        try (ZipFile zip = new ZipFile(path)) {
            ZipEntry mods = zip.getEntry("wml/mods/mods.js");
            if (mods == null) {
                Enumeration<? extends ZipEntry> entries = zip.entries();
                while (entries.hasMoreElements()) {
                    ZipEntry candidate = entries.nextElement();
                    if (!candidate.isDirectory() && candidate.getName().endsWith("/wml/mods/mods.js")) {
                        mods = candidate;
                        break;
                    }
                }
            }
            check(mods != null, "pinned mods.zip must contain wml/mods/mods.js");
            String source;
            try (InputStream in = zip.getInputStream(mods);
                 ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = in.read(buffer)) >= 0) {
                    if (count > 0) bytes.write(buffer, 0, count);
                }
                source = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
            }
            check(WmlModListBootstrap.hasEnableList(source),
                    "pinned WML mods.js must expose a WML.enable([...]) list");
            String result = WmlModListBootstrap.ensureCloudSaveEnabled(source);
            check(WmlModListBootstrap.hasCloudSaveEntry(result),
                    "CloudSave must be enabled or explicitly opted out in the pinned WML mods.js");
            check(WmlModListBootstrap.ensureCloudSaveEnabled(result).equals(result),
                    "patching the pinned WML mods.js must be idempotent");
        }
    }
}
