package com.wayward.launcher;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.SequenceInputStream;
import java.nio.charset.StandardCharsets;

final class WmlModListBootstrap {
    private static final int MAX_MODS_JS_BYTES = 1024 * 1024;

    private WmlModListBootstrap() {}

    static InputStream patch(InputStream source) throws IOException {
        if (source == null) return null;
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        boolean handedOff = false;
        try {
            int count;
            while ((count = source.read(buffer)) >= 0) {
                if (count == 0) continue;
                if (captured.size() + count > MAX_MODS_JS_BYTES) {
                    handedOff = true;
                    return new SequenceInputStream(new ByteArrayInputStream(captured.toByteArray()), source);
                }
                captured.write(buffer, 0, count);
            }
            String original = new String(captured.toByteArray(), StandardCharsets.UTF_8);
            String updated = ensureCloudSaveEnabled(original);
            return new ByteArrayInputStream(updated.getBytes(StandardCharsets.UTF_8));
        } finally {
            if (!handedOff) source.close();
        }
    }

    static boolean hasEnableList(String source) {
        return findEnableArrayOpen(source) >= 0;
    }

    static boolean hasCloudSaveEntry(String source) {
        int open = findEnableArrayOpen(source);
        if (open < 0) return false;
        int close = findClosingBracket(source, open);
        return close >= 0 && containsCloudSave(removeComments(source.substring(open + 1, close)));
    }

    static String ensureCloudSaveEnabled(String source) {
        if (source == null || source.isEmpty()) return source;
        int open = findEnableArrayOpen(source);
        if (open < 0) return source;
        int close = findClosingBracket(source, open);
        if (close < 0) return source;
        String entries = removeComments(source.substring(open + 1, close));
        if (containsCloudSave(entries)) return source;

        int last = lastSignificantChar(source, open + 1, close);
        String comma = last >= 0 && source.charAt(last) != ',' ? "," : "";
        return source.substring(0, close)
                + comma + System.lineSeparator() + "  " + (char) 34 + "cloud-save" + (char) 34
                + source.substring(close);
    }

    private static boolean containsCloudSave(String source) {
        return source.contains("'cloud-save'") || source.contains("\"cloud-save\"")
                || source.contains("'cloud-save:off'") || source.contains("\"cloud-save:off\"");
    }

    private static int findEnableArrayOpen(String source) {
        if (source == null) return -1;
        for (int i = 0; i < source.length();) {
            char c = source.charAt(i);
            if (c == '/' && i + 1 < source.length()) {
                char next = source.charAt(i + 1);
                if (next == '/') { i = skipLineComment(source, i + 2); continue; }
                if (next == '*') { i = skipBlockComment(source, i + 2); continue; }
            }
            if (isQuote(c)) { i = skipString(source, i); continue; }
            if (source.startsWith("WML", i)
                    && (i == 0 || !isIdentifierPart(source.charAt(i - 1)))
                    && (i + 3 == source.length() || !isIdentifierPart(source.charAt(i + 3)))) {
                int p = skipTrivia(source, i + 3);
                if (p < source.length() && source.charAt(p) == '.') {
                    p = skipTrivia(source, p + 1);
                    if (source.startsWith("enable", p)
                            && (p + 6 == source.length() || !isIdentifierPart(source.charAt(p + 6)))) {
                        p = skipTrivia(source, p + 6);
                        if (p < source.length() && source.charAt(p) == '(') {
                            p = skipTrivia(source, p + 1);
                            if (p < source.length() && source.charAt(p) == '[') return p;
                        }
                    }
                }
            }
            i++;
        }
        return -1;
    }

    private static int findClosingBracket(String source, int open) {
        int depth = 0;
        for (int i = open; i < source.length();) {
            char c = source.charAt(i);
            if (c == '/' && i + 1 < source.length()) {
                char next = source.charAt(i + 1);
                if (next == '/') { i = skipLineComment(source, i + 2); continue; }
                if (next == '*') { i = skipBlockComment(source, i + 2); continue; }
            }
            if (isQuote(c)) { i = skipString(source, i); continue; }
            if (c == '[') depth++;
            else if (c == ']') {
                depth--;
                if (depth == 0) return i;
            }
            i++;
        }
        return -1;
    }

    private static int lastSignificantChar(String source, int start, int end) {
        int last = -1;
        for (int i = start; i < end;) {
            char c = source.charAt(i);
            if (c == '/' && i + 1 < end) {
                char next = source.charAt(i + 1);
                if (next == '/') { i = skipLineComment(source, i + 2); continue; }
                if (next == '*') { i = skipBlockComment(source, i + 2); continue; }
            }
            if (isQuote(c)) {
                int after = Math.min(skipString(source, i), end);
                if (after > i) last = after - 1;
                i = after;
                continue;
            }
            if (!Character.isWhitespace(c)) last = i;
            i++;
        }
        return last;
    }

    private static String removeComments(String source) {
        StringBuilder out = new StringBuilder(source.length());
        for (int i = 0; i < source.length();) {
            char c = source.charAt(i);
            if (c == '/' && i + 1 < source.length()) {
                char next = source.charAt(i + 1);
                if (next == '/') {
                    i = skipLineComment(source, i + 2);
                    out.append(' ');
                    continue;
                }
                if (next == '*') {
                    i = skipBlockComment(source, i + 2);
                    out.append(' ');
                    continue;
                }
            }
            if (isQuote(c)) {
                int end = skipString(source, i);
                out.append(source, i, end);
                i = end;
                continue;
            }
            out.append(c);
            i++;
        }
        return out.toString();
    }

    private static int skipTrivia(String source, int index) {
        int i = index;
        while (i < source.length()) {
            if (Character.isWhitespace(source.charAt(i))) { i++; continue; }
            if (source.charAt(i) == '/' && i + 1 < source.length()) {
                char next = source.charAt(i + 1);
                if (next == '/') { i = skipLineComment(source, i + 2); continue; }
                if (next == '*') { i = skipBlockComment(source, i + 2); continue; }
            }
            break;
        }
        return i;
    }

    private static int skipLineComment(String source, int index) {
        int i = index;
        while (i < source.length() && source.charAt(i) != 10 && source.charAt(i) != 13) i++;
        return i;
    }

    private static int skipBlockComment(String source, int index) {
        int end = source.indexOf("*/", index);
        return end < 0 ? source.length() : end + 2;
    }

    private static int skipString(String source, int start) {
        char quote = source.charAt(start);
        int i = start + 1;
        while (i < source.length()) {
            char c = source.charAt(i++);
            if (c == 92) { if (i < source.length()) i++; continue; }
            if (c == quote) break;
        }
        return i;
    }

    private static boolean isQuote(char c) {
        return c == 39 || c == 34 || c == 96;
    }

    private static boolean isIdentifierPart(char c) {
        return Character.isLetterOrDigit(c) || c == '_' || c == '$';
    }
}
