package com.wayward.launcher;

import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;

import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Test-only SAF provider used to exercise MainActivity's real FolderHandler path. */
public final class CdnFallbackTestDocumentsProvider extends DocumentsProvider {
    static final String AUTHORITY = "com.wayward.launcher.test.documents";
    static final String ROOT_ID = "root";
    private static final String IMAGE_ID = "root/images/illustrious/situation/info/pippa/wal-cdn-fallback-saf.png";
    private static final byte[] PNG = android.util.Base64.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
            android.util.Base64.DEFAULT);

    private static final class Entry {
        final String id;
        final String name;
        final String mime;
        final long size;
        final long modified;
        Entry(String id,String name,String mime,long size) {
            this.id=id;this.name=name;this.mime=mime;this.size=size;this.modified=1L;
        }
        boolean isDirectory(){return DocumentsContract.Document.MIME_TYPE_DIR.equals(mime);}
    }

    private static final Map<String,Entry> ENTRIES = new HashMap<>();
    private static final Map<String,List<String>> CHILDREN = new HashMap<>();
    private static int QUERY_COUNT;
    private static int OPEN_COUNT;

    static synchronized void reset() {
        ENTRIES.clear();
        CHILDREN.clear();
        QUERY_COUNT=0;
        OPEN_COUNT=0;
        add("root","root",DocumentsContract.Document.MIME_TYPE_DIR,0);
        add("root/images","images",DocumentsContract.Document.MIME_TYPE_DIR,0);
        add("root/images/illustrious","illustrious",DocumentsContract.Document.MIME_TYPE_DIR,0);
        add("root/images/illustrious/situation","situation",DocumentsContract.Document.MIME_TYPE_DIR,0);
        add("root/images/illustrious/situation/info","info",DocumentsContract.Document.MIME_TYPE_DIR,0);
        add("root/images/illustrious/situation/info/pippa","pippa",DocumentsContract.Document.MIME_TYPE_DIR,0);
        add(IMAGE_ID,"wal-cdn-fallback-saf.png","image/png",PNG.length);
    }

    static synchronized void resetCounters() { QUERY_COUNT=0; OPEN_COUNT=0; }
    static synchronized int queryCount() { return QUERY_COUNT; }
    static synchronized int openCount() { return OPEN_COUNT; }

    private static void add(String id,String name,String mime,long size) {
        ENTRIES.put(id,new Entry(id,name,mime,size));
        int slash=id.lastIndexOf('/');
        if(slash>=0)CHILDREN.computeIfAbsent(id.substring(0,slash),ignored->new ArrayList<>()).add(id);
    }

    @Override public boolean onCreate() { reset(); return true; }

    @Override public Cursor queryRoots(String[] projection) {
        synchronized(CdnFallbackTestDocumentsProvider.class){QUERY_COUNT++;}
        String[] columns=projection==null?new String[]{
                DocumentsContract.Root.COLUMN_ROOT_ID,
                DocumentsContract.Root.COLUMN_FLAGS,
                DocumentsContract.Root.COLUMN_TITLE,
                DocumentsContract.Root.COLUMN_DOCUMENT_ID,
                DocumentsContract.Root.COLUMN_MIME_TYPES,
                DocumentsContract.Root.COLUMN_AVAILABLE_BYTES
        }:projection;
        MatrixCursor cursor=new MatrixCursor(columns);
        Object[] row=new Object[columns.length];
        for(int i=0;i<columns.length;i++){
            String c=columns[i];
            if(DocumentsContract.Root.COLUMN_ROOT_ID.equals(c))row[i]=ROOT_ID;
            else if(DocumentsContract.Root.COLUMN_FLAGS.equals(c))row[i]=0;
            else if(DocumentsContract.Root.COLUMN_TITLE.equals(c))row[i]="WAL CDN fallback test";
            else if(DocumentsContract.Root.COLUMN_DOCUMENT_ID.equals(c))row[i]=ROOT_ID;
            else if(DocumentsContract.Root.COLUMN_MIME_TYPES.equals(c))row[i]="image/*";
            else if(DocumentsContract.Root.COLUMN_AVAILABLE_BYTES.equals(c))row[i]=0L;
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override public Cursor queryDocument(String documentId,String[] projection) {
        synchronized(CdnFallbackTestDocumentsProvider.class){QUERY_COUNT++;}
        Entry entry;
        synchronized(CdnFallbackTestDocumentsProvider.class){entry=ENTRIES.get(documentId);}
        MatrixCursor cursor=new MatrixCursor(columns(projection));
        if(entry!=null)cursor.addRow(documentRow(entry,cursor.getColumnNames()));
        return cursor;
    }

    @Override public Cursor queryChildDocuments(String parentDocumentId,String[] projection,String sortOrder) {
        synchronized(CdnFallbackTestDocumentsProvider.class){QUERY_COUNT++;}
        MatrixCursor cursor=new MatrixCursor(columns(projection));
        List<String> ids;
        synchronized(CdnFallbackTestDocumentsProvider.class){
            ids=new ArrayList<>(CHILDREN.getOrDefault(parentDocumentId,Collections.emptyList()));
        }
        for(String id:ids){
            Entry entry;
            synchronized(CdnFallbackTestDocumentsProvider.class){entry=ENTRIES.get(id);}
            if(entry!=null)cursor.addRow(documentRow(entry,cursor.getColumnNames()));
        }
        return cursor;
    }

    private static String[] columns(String[] projection) {
        return projection==null?new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                DocumentsContract.Document.COLUMN_FLAGS
        }:projection;
    }

    private static Object[] documentRow(Entry entry,String[] columns) {
        Object[] row=new Object[columns.length];
        for(int i=0;i<columns.length;i++){
            String c=columns[i];
            if(DocumentsContract.Document.COLUMN_DOCUMENT_ID.equals(c))row[i]=entry.id;
            else if(DocumentsContract.Document.COLUMN_DISPLAY_NAME.equals(c))row[i]=entry.name;
            else if(DocumentsContract.Document.COLUMN_MIME_TYPE.equals(c))row[i]=entry.mime;
            else if(DocumentsContract.Document.COLUMN_SIZE.equals(c))row[i]=entry.size;
            else if(DocumentsContract.Document.COLUMN_LAST_MODIFIED.equals(c))row[i]=entry.modified;
            else if(DocumentsContract.Document.COLUMN_FLAGS.equals(c))row[i]=0;
        }
        return row;
    }

    @Override public String getDocumentType(String documentId) {
        synchronized(CdnFallbackTestDocumentsProvider.class){
            Entry entry=ENTRIES.get(documentId);
            return entry==null?null:entry.mime;
        }
    }

    @Override public boolean isChildDocument(String parentDocumentId,String documentId) {
        return parentDocumentId!=null&&documentId!=null
                &&(documentId.equals(parentDocumentId)||documentId.startsWith(parentDocumentId+"/"));
    }

    @Override public ParcelFileDescriptor openDocument(String documentId,String mode,
                                                         CancellationSignal signal) throws java.io.FileNotFoundException {
        if(!IMAGE_ID.equals(documentId))throw new java.io.FileNotFoundException(documentId);
        synchronized(CdnFallbackTestDocumentsProvider.class){OPEN_COUNT++;}
        ParcelFileDescriptor[] pipe;
        try{pipe=ParcelFileDescriptor.createPipe();}
        catch(IOException error){throw new java.io.FileNotFoundException(error.getMessage());}
        Thread writer=new Thread(()->{
            try(FileOutputStream output=new FileOutputStream(pipe[1].getFileDescriptor())){
                output.write(PNG);
                output.flush();
            }catch(IOException ignored){
            }finally{
                try{pipe[1].close();}catch(IOException ignored){}
            }
        },"cdn-fallback-test-saf-writer");
        writer.start();
        return pipe[0];
    }
}
