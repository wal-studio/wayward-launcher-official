package com.wayward.launcher;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public final class WmlModListBootstrapTest {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        String quote = String.valueOf((char) 34);
        String fixture = "/* WML mod list */\nWML.enable([\n"
                + "  " + quote + "addon-compat" + quote + ",\n"
                + "  " + quote + "imagestudio:off" + quote + ", // keep this state\n"
                + "]);\n";
        final boolean[] originalClosed = { false };
        InputStream trackedSource = new ByteArrayInputStream(fixture.getBytes(StandardCharsets.UTF_8)) {
            @Override public void close() throws IOException {
                originalClosed[0] = true;
                super.close();
            }
        };
        try (InputStream patchedStream = WmlModListBootstrap.patch(trackedSource)) {
            patchedStream.readAllBytes();
        }
        check(originalClosed[0], "buffered source stream must be closed after response patching");

        String patched = WmlModListBootstrap.ensureCloudSaveEnabled(fixture);
        check(WmlModListBootstrap.hasCloudSaveEntry(patched), "CloudSave must be added to the enable list");
        check(patched.contains(quote + "addon-compat" + quote), "existing enabled mods must be preserved");
        check(patched.contains(quote + "imagestudio:off" + quote), "existing disabled mods must be preserved");
        check(patched.indexOf(quote + "imagestudio:off" + quote) < patched.indexOf(quote + "cloud-save" + quote),
                "CloudSave must be appended after existing mods");
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

        String trailingComment = "WML.enable(['addon-compat' // existing comment\n]);";
        String trailingPatched = WmlModListBootstrap.ensureCloudSaveEnabled(trailingComment);
        check(WmlModListBootstrap.hasCloudSaveEntry(trailingPatched),
                "a trailing line comment must not prevent insertion");

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

        System.out.println("WML CloudSave enable-list bootstrap tests passed");
    }
}
