package com.iptv.player.zero;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

public class CastService extends Service {
    private static final String CHANNEL_ID = "cast_playback_channel";
    private static final int NOTIFICATION_ID = 9923;

    public static final String ACTION_PLAY = "com.iptv.player.zero.ACTION_PLAY";
    public static final String ACTION_PAUSE = "com.iptv.player.zero.ACTION_PAUSE";
    public static final String ACTION_NEXT = "com.iptv.player.zero.ACTION_NEXT";
    public static final String ACTION_PREV = "com.iptv.player.zero.ACTION_PREV";
    public static final String ACTION_STOP = "com.iptv.player.zero.ACTION_STOP";

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (action != null) {
                CastPlugin.onNotificationAction(action);
                if (ACTION_STOP.equals(action)) {
                    stopSelf();
                    return START_NOT_STICKY;
                }
            }
            
            String title = intent.getStringExtra("title");
            if (title == null) title = "ZIPTV Pro Casting";
            
            showNotification(title);
        }
        return START_NOT_STICKY;
    }

    private void showNotification(String title) {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        notificationIntent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, notificationIntent, pendingFlags);

        PendingIntent prevPI = createActionPI(ACTION_PREV);
        PendingIntent nextPI = createActionPI(ACTION_NEXT);
        PendingIntent stopPI = createActionPI(ACTION_STOP);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText("Casting to TV")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .addAction(android.R.drawable.ic_media_previous, "Previous", prevPI)
                .addAction(android.R.drawable.ic_media_next, "Next", nextPI)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPI);

        builder.setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setShowActionsInCompactView(0, 1, 2)
                .setShowCancelButton(true)
                .setCancelButtonIntent(stopPI));

        Notification notification = builder.build();
        startForeground(NOTIFICATION_ID, notification);
    }

    private PendingIntent createActionPI(String action) {
        Intent intent = new Intent(this, CastService.class);
        intent.setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getService(this, action.hashCode(), intent, flags);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel serviceChannel = new NotificationChannel(
                    CHANNEL_ID,
                    "ZIPTV Pro Casting Channel",
                    NotificationManager.IMPORTANCE_LOW
            );
            serviceChannel.setDescription("Casting playback control notification");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(serviceChannel);
            }
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
