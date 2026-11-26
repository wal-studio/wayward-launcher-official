package com.wayward.launcher;

import java.io.IOException;

/** Explicit Host-signed proof that the locally stored pairing generation is no longer current. */
final class RemoteHostDeviceRevokedException extends IOException {
    RemoteHostDeviceRevokedException(String message){super(message);}
}
