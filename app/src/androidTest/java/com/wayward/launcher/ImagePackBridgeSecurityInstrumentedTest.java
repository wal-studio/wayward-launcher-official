package com.wayward.launcher;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class ImagePackBridgeSecurityInstrumentedTest {
    @Test public void nativeCapabilityMustMatchExactly() {
        String capability = ImagePackFolderPickerScript.createCapability();
        assertTrue(ImagePackFolderPickerScript.matchesCapability(capability, capability));
        assertFalse(ImagePackFolderPickerScript.matchesCapability(capability, capability + "x"));
        assertFalse(ImagePackFolderPickerScript.matchesCapability(capability, ""));
        assertFalse(ImagePackFolderPickerScript.matchesCapability("", capability));
    }

    @Test public void runtimeInjectionRejectsForeignOrigins() {
        String origin = "https://localhost:12345";
        assertTrue(ImagePackFolderPickerScript.isSameOrigin(
                "https://localhost:12345/game/Wayward_WML_ko.html", origin));
        assertFalse(ImagePackFolderPickerScript.isSameOrigin(
                "http://localhost:12345/game/Wayward_WML_ko.html", origin));
        assertFalse(ImagePackFolderPickerScript.isSameOrigin(
                "https://localhost:12346/game/Wayward_WML_ko.html", origin));
        assertFalse(ImagePackFolderPickerScript.isSameOrigin(
                "https://evil.localhost:12345/game/Wayward_WML_ko.html", origin));
        assertFalse(ImagePackFolderPickerScript.isSameOrigin(
                "https://user@localhost:12345/game/Wayward_WML_ko.html", origin));
    }
}
