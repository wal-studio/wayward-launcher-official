package com.wayward.launcher;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.time.Instant;

import javax.net.ssl.HttpsURLConnection;

/** Lifecycle-bound, single-owner SSE monitor for explicit PC-side pairing revocations. */
final class RemoteHostRevocationMonitor {
    interface Listener {
        void onRevoked();
        default void onConnectionLost() {}
    }

    private static final String TAG="WaywardRemotePair";
    private static final Object LOCK=new Object();
    private static RemoteHostRevocationMonitor active;

    static void start(Activity owner,Listener listener) throws Exception {
        if(owner==null||listener==null||!RemoteHostStore.isPaired(owner))return;
        RemoteHostConnection host=RemoteHostStore.loadConnection(owner);
        if(host==null)return;
        synchronized(LOCK){
            long registeredAt=RemoteHostStore.getPairedRegisteredAtUtc(owner);
            if(active!=null&&active.running&&active.thread.isAlive()&&active.owner.get()==owner
                    &&active.host.hostId.equalsIgnoreCase(host.hostId)
                    &&active.registeredAtUtcMillis==registeredAt){
                active.listener=listener;
                return;
            }
            if(active!=null)active.stopInternal();
            active=new RemoteHostRevocationMonitor(owner,host,listener,registeredAt);
            active.thread.start();
        }
    }

    static void stop(Activity owner){
        synchronized(LOCK){
            if(active==null||active.owner.get()!=owner)return;
            active.stopInternal();
            active=null;
        }
    }

    private final WeakReference<Activity> owner;
    private final RemoteHostConnection host;
    private volatile long registeredAtUtcMillis;
    private volatile Listener listener;
    private volatile boolean running=true;
    private volatile HttpsURLConnection connection;
    private final Thread thread;
    private final Handler main=new Handler(Looper.getMainLooper());
    private boolean connectionLostNotified;

    private RemoteHostRevocationMonitor(Activity owner,RemoteHostConnection host,Listener listener,long registeredAtUtcMillis){
        this.owner=new WeakReference<>(owner);
        this.host=host;
        this.listener=listener;
        this.registeredAtUtcMillis=registeredAtUtcMillis;
        this.thread=new Thread(this::run,"Wayward-Remote-Revocation-SSE");
        this.thread.setDaemon(true);
    }

    private void run(){
        long backoff=1000L;
        boolean wasConnected=false;
        while(running){
            Activity activity=owner.get();
            if(activity==null||activity.isFinishing()||activity.isDestroyed())return;
            try{
                RemoteHostConnection current=RemoteHostStore.loadConnection(activity);
                if(current==null||!RemoteHostStore.isPaired(activity)||
                        !host.hostId.equalsIgnoreCase(current.hostId))return;
                RemoteHostClient.authenticate(activity,current);
                long currentGeneration=RemoteHostStore.getPairedRegisteredAtUtc(activity);
                if(registeredAtUtcMillis==0L&&currentGeneration>0L)registeredAtUtcMillis=currentGeneration;
                if(registeredAtUtcMillis>0L&&currentGeneration!=registeredAtUtcMillis)return;
                HttpsURLConnection opened=RemoteHostClient.openRevocationEvents(activity,current);
                connection=opened;
                wasConnected=true;
                connectionLostNotified=false;
                backoff=1000L;
                try(BufferedReader reader=new BufferedReader(
                        new InputStreamReader(opened.getInputStream(),StandardCharsets.UTF_8))){
                    String eventName="";
                    StringBuilder data=new StringBuilder();
                    String line;
                    while(running&&(line=reader.readLine())!=null){
                        if(line.isEmpty()){
                            if("revoked".equals(eventName)&&data.length()>0&&handleEvent(activity,data.toString()))return;
                            eventName="";
                            data.setLength(0);
                        }else if(line.startsWith("event:")){
                            eventName=line.substring(6).trim();
                        }else if(line.startsWith("data:")){
                            if(data.length()>0)data.append('\n');
                            data.append(line.substring(5).trim());
                        }
                    }
                }finally{
                    opened.disconnect();
                    if(connection==opened)connection=null;
                }
                if(running&&wasConnected)notifyConnectionLost();
            }catch(Exception error){
                if(RemoteHostClient.isDeviceRevokedError(error)){
                    if(clearCurrentGeneration(activity))return;
                }else{
                    Log.w(TAG,"stage=revocation_sse result=retry error="+error.getClass().getSimpleName());
                }
                if(wasConnected&&running)notifyConnectionLost();
            }
            if(!running)return;
            try{Thread.sleep(backoff);}catch(InterruptedException ignored){if(!running)return;}
            backoff=Math.min(30_000L,backoff*2L);
        }
    }

    private boolean handleEvent(Activity activity,String json){
        try{
            JSONObject event=new JSONObject(json);
            String eventDevice=event.getString("deviceId");
            long eventRegisteredAt=Instant.parse(event.getString("registeredAtUtc")).toEpochMilli();
            String eventFingerprint=event.getString("publicKeyFingerprint");
            String localDevice=RemoteHostStore.getDeviceId(activity);
            long localRegisteredAt=RemoteHostStore.getPairedRegisteredAtUtc(activity);
            String localFingerprint=RemoteHostConnection.sha256Hex(
                    Base64.decode(RemoteHostStore.publicKeyBase64(activity),Base64.DEFAULT));
            if(!localDevice.equalsIgnoreCase(eventDevice)||
                    localRegisteredAt<=0L||localRegisteredAt!=eventRegisteredAt||
                    (registeredAtUtcMillis>0L&&registeredAtUtcMillis!=eventRegisteredAt)||
                    !localFingerprint.equalsIgnoreCase(eventFingerprint))return false;
            if(!RemoteHostStore.clearPaired(activity,host.hostId,eventRegisteredAt))return false;
            RemoteHostClient.clearSession();
            notifyRevoked();
            stopInternal();
            return true;
        }catch(Exception error){
            Log.w(TAG,"stage=revocation_event result=ignored error="+error.getClass().getSimpleName());
            return false;
        }
    }

    private boolean clearCurrentGeneration(Activity activity){
        try{
            long registeredAt=registeredAtUtcMillis;
            if(registeredAt<=0L){
                RemoteHostClient.clearSession();
                return false;
            }
            if(!RemoteHostStore.clearPaired(activity,host.hostId,registeredAt))return false;
            notifyRevoked();
            stopInternal();
            return true;
        }catch(Exception error){
            Log.w(TAG,"stage=revocation_recheck result=preserved error="+error.getClass().getSimpleName());
            return false;
        }
    }

    private void notifyRevoked(){
        Listener target=listener;
        Activity activity=owner.get();
        if(target==null||activity==null)return;
        main.post(()->{if(!activity.isFinishing()&&!activity.isDestroyed())target.onRevoked();});
    }

    private void notifyConnectionLost(){
        if(connectionLostNotified)return;
        connectionLostNotified=true;
        Listener target=listener;
        Activity activity=owner.get();
        if(target==null||activity==null)return;
        main.post(()->{if(!activity.isFinishing()&&!activity.isDestroyed())target.onConnectionLost();});
    }

    private void stopInternal(){
        running=false;
        HttpsURLConnection current=connection;
        connection=null;
        if(current!=null)current.disconnect();
        thread.interrupt();
    }
}
