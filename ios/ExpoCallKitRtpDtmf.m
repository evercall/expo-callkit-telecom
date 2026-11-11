#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#if __has_include(<livekit_react_native_webrtc/WebRTCModule.h>)
#import <livekit_react_native_webrtc/WebRTCModule.h>
#else
#import <livekit-react-native-webrtc/WebRTCModule.h>
#endif

@interface ExpoRtpDtmfJob : NSObject
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, strong) NSNumber *peerConnectionId;
@property(nonatomic, copy) NSString *senderId;
@property(nonatomic, copy) NSString *tones;
@property(nonatomic, copy) NSString *callId;
@property(nonatomic, strong) dispatch_source_t timer;
@property(nonatomic, copy) RCTPromiseResolveBlock resolve;
@property(nonatomic, copy) RCTPromiseRejectBlock reject;
@property(nonatomic) BOOL pending;
@property(nonatomic) NSInteger previousRemaining;
@property(nonatomic) NSTimeInterval lastProgress;
@end
@implementation ExpoRtpDtmfJob
@end

// A React Native module lets the current module registry resolve WebRTC in both
// bridge and bridgeless runtimes, without relying on Expo's private bridge APIs.
@interface ExpoCallKitRtpDtmf : NSObject <RCTBridgeModule, RCTInvalidating>
@property(nonatomic, weak) RCTModuleRegistry *moduleRegistry;
@end

@implementation ExpoCallKitRtpDtmf {
    NSMutableDictionary<NSString *, ExpoRtpDtmfJob *> *_jobs;
    NSMutableOrderedSet<NSString *> *_endedCalls;
}
RCT_EXPORT_MODULE(ExpoCallKitRtpDtmf)
@synthesize moduleRegistry = _moduleRegistry;

+ (BOOL)requiresMainQueueSetup { return NO; }

- (NSDictionary *)constantsToExport {
    return @{ @"dtmfSchedulerVersion": @2 };
}


- (instancetype)init {
    if ((self = [super init])) {
        _jobs = [NSMutableDictionary new];
        _endedCalls = [NSMutableOrderedSet new];
        [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(callRemoved:)
            name:@"ExpoCallKitTelecomCallSessionRemoved" object:nil];
    }
    return self;
}

- (WebRTCModule *)webRTCModule {
    return [self.moduleRegistry moduleForName:"WebRTCModule" lazilyLoadIfNecessary:YES];
}

- (void)finishJob:(ExpoRtpDtmfJob *)job error:(NSString *)error cancelled:(BOOL)cancelled {
    dispatch_source_cancel(job.timer);
    job.timer = nil;
    [_jobs removeObjectForKey:job.identifier];
    if (error) {
        NSLog(@"[ExpoCallKitRtpDtmf] Failed pc=%@ sender=%@: %@", job.peerConnectionId, job.senderId, error);
        job.reject(@"ERR_RTP_DTMF", error, nil);
    } else {
        NSLog(@"[ExpoCallKitRtpDtmf] %@ pc=%@ sender=%@", cancelled ? @"Cancelled" : @"Native RTP queue drained", job.peerConnectionId, job.senderId);
        job.resolve(@{ @"nativeQueueDrained": @(!cancelled), @"cancelled": @(cancelled) });
    }
}

- (RTCRtpSender *)senderForJob:(ExpoRtpDtmfJob *)job module:(WebRTCModule *)module {
    RTCPeerConnection *connection = module.peerConnections[job.peerConnectionId];
    if (!connection || connection.connectionState == RTCPeerConnectionStateClosed) return nil;
    for (RTCRtpSender *sender in connection.senders) {
        if ([sender.senderId isEqualToString:job.senderId] && [sender.track.kind isEqualToString:@"audio"]) return sender;
    }
    return nil;
}

- (void)cancelJob:(ExpoRtpDtmfJob *)job module:(WebRTCModule *)module {
    if (!job.pending) {
        id<RTCDtmfSender> dtmf = [self senderForJob:job module:module].dtmfSender;
        [dtmf insertDtmf:@"" duration:0.1 interToneGap:0.5];
    }
    [self finishJob:job error:nil cancelled:YES];
}

- (void)callRemoved:(NSNotification *)notification {
    NSString *callId = [(NSString *)notification.object lowercaseString];
    WebRTCModule *module = [self webRTCModule];
    if (!module.workerQueue) return;
    dispatch_async(module.workerQueue, ^{
        [self->_endedCalls addObject:callId];
        if (self->_endedCalls.count > 128) [self->_endedCalls removeObjectAtIndex:0];
        for (ExpoRtpDtmfJob *job in [self->_jobs.allValues copy]) {
            if (!job.callId || [job.callId isEqualToString:callId]) [self cancelJob:job module:module];
        }
    });
}

- (void)invalidate {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    WebRTCModule *module = [self webRTCModule];
    if (!module.workerQueue) return;
    dispatch_async(module.workerQueue, ^{
        for (ExpoRtpDtmfJob *job in [self->_jobs.allValues copy]) [self cancelJob:job module:module];
    });
}

- (void)enqueue:(NSNumber *)peerConnectionId senderId:(NSString *)senderId tones:(NSString *)tones
        delayMs:(NSNumber *)delayMs callId:(NSString *)callId
        resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
    NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789ABCD#*,"] invertedSet];
    if (tones.length == 0 || [tones rangeOfCharacterFromSet:invalid].location != NSNotFound ||
        !isfinite(delayMs.doubleValue) || delayMs.doubleValue < 0 || delayMs.doubleValue > 60000) {
        reject(@"ERR_RTP_DTMF", @"Invalid DTMF tones or delay", nil);
        return;
    }
    WebRTCModule *module = [self webRTCModule];
    if (![module isKindOfClass:[WebRTCModule class]] || !module.workerQueue) {
        reject(@"ERR_RTP_DTMF", @"WebRTC module is unavailable", nil);
        return;
    }
    dispatch_async(module.workerQueue, ^{
        ExpoRtpDtmfJob *job = [ExpoRtpDtmfJob new];
        job.identifier = NSUUID.UUID.UUIDString;
        job.peerConnectionId = peerConnectionId;
        job.senderId = senderId;
        job.tones = tones;
        job.callId = callId.lowercaseString;
        job.resolve = resolve;
        job.reject = reject;
        job.pending = YES;
        job.previousRemaining = -1;
        job.timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, module.workerQueue);
        self->_jobs[job.identifier] = job;
        NSLog(@"[ExpoCallKitRtpDtmf] Scheduled pc=%@ sender=%@ symbols=%lu delayMs=%@", peerConnectionId, senderId, (unsigned long)tones.length, delayMs);
        __weak ExpoCallKitRtpDtmf *weakSelf = self;
        dispatch_source_set_event_handler(job.timer, ^{
            ExpoCallKitRtpDtmf *owner = weakSelf;
            if (!owner) return;
            if (job.callId && [owner->_endedCalls containsObject:job.callId]) {
                [owner cancelJob:job module:module];
                return;
            }
            RTCRtpSender *sender = [owner senderForJob:job module:module];
            id<RTCDtmfSender> dtmf = sender.dtmfSender;
            if (!dtmf) {
                [owner finishJob:job error:@"WebRTC RTP audio sender is unavailable" cancelled:NO];
                return;
            }
            if (job.pending) {
                if (!dtmf.canInsertDtmf || ![dtmf insertDtmf:[[dtmf remainingTones] stringByAppendingString:job.tones] duration:0.1 interToneGap:0.5]) {
                    [owner finishJob:job error:@"WebRTC rejected RTP DTMF: check telephone-event negotiation and active audio" cancelled:NO];
                    return;
                }
                job.pending = NO;
                NSLog(@"[ExpoCallKitRtpDtmf] Native WebRTC accepted RTP sequence pc=%@ sender=%@ symbols=%lu", peerConnectionId, senderId, (unsigned long)tones.length);
            }
            NSInteger remaining = [dtmf remainingTones].length;
            NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
            if (remaining != job.previousRemaining) {
                job.previousRemaining = remaining;
                job.lastProgress = now;
                NSLog(@"[ExpoCallKitRtpDtmf] Queue progress pc=%@ sender=%@ remainingSymbols=%ld canInsert=%d audioTrackEnabled=%d", peerConnectionId, senderId, (long)remaining, dtmf.canInsertDtmf, sender.track.isEnabled);
            }
            if (remaining == 0) {
                [owner finishJob:job error:nil cancelled:NO];
            } else if (!dtmf.canInsertDtmf || now - job.lastProgress >= 10) {
                [owner finishJob:job error:[NSString stringWithFormat:@"Native RTP queue stopped with %ld symbols remaining", (long)remaining] cancelled:NO];
            }
        });
        dispatch_source_set_timer(job.timer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delayMs.doubleValue * NSEC_PER_MSEC)), 250 * NSEC_PER_MSEC, 10 * NSEC_PER_MSEC);
        dispatch_resume(job.timer);
    });
}

RCT_EXPORT_METHOD(scheduleRtpDtmf:(nonnull NSNumber *)peerConnectionId senderId:(NSString *)senderId
                  tones:(NSString *)tones delayMs:(nonnull NSNumber *)delayMs callId:(NSString *)callId
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
    [self enqueue:peerConnectionId senderId:senderId tones:tones delayMs:delayMs callId:callId resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(cancelRtpDtmf:(nonnull NSNumber *)peerConnectionId senderId:(NSString *)senderId
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
    WebRTCModule *module = [self webRTCModule];
    if (!module.workerQueue) { resolve(nil); return; }
    dispatch_async(module.workerQueue, ^{
        for (ExpoRtpDtmfJob *job in [self->_jobs.allValues copy]) {
            if ([job.peerConnectionId isEqual:peerConnectionId] && [job.senderId isEqualToString:senderId]) [self cancelJob:job module:module];
        }
        resolve(nil);
    });
}


- (void)withSender:(NSNumber *)peerConnectionId
         senderId:(NSString *)senderId
           reject:(RCTPromiseRejectBlock)reject
            block:(void (^)(RTCRtpSender *sender))block {
    WebRTCModule *module = [self.moduleRegistry moduleForName:"WebRTCModule" lazilyLoadIfNecessary:YES];
    if (![module isKindOfClass:[WebRTCModule class]] || !module.workerQueue) {
        reject(@"ERR_RTP_DTMF", @"WebRTC module is unavailable", nil);
        return;
    }
    dispatch_async(module.workerQueue, ^{
        RTCPeerConnection *connection = module.peerConnections[peerConnectionId];
        if (!connection || connection.connectionState == RTCPeerConnectionStateClosed) {
            reject(@"ERR_RTP_DTMF", @"WebRTC peer connection is unavailable", nil);
            return;
        }
        for (RTCRtpSender *sender in connection.senders) {
            if ([sender.senderId isEqualToString:senderId] && [sender.track.kind isEqualToString:@"audio"]) {
                if (!sender.dtmfSender) {
                    reject(@"ERR_RTP_DTMF", @"RTP DTMF sender is unavailable", nil);
                    return;
                }
                block(sender);
                return;
            }
        }
        reject(@"ERR_RTP_DTMF", @"WebRTC audio sender is unavailable", nil);
    });
}

RCT_EXPORT_METHOD(sendRtpDtmf:(nonnull NSNumber *)peerConnectionId
                  senderId:(NSString *)senderId
                  tones:(NSString *)tones
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [self enqueue:peerConnectionId senderId:senderId tones:tones delayMs:@0 callId:nil resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(getRtpDtmfState:(nonnull NSNumber *)peerConnectionId
                  senderId:(NSString *)senderId
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [self withSender:peerConnectionId senderId:senderId reject:reject block:^(RTCRtpSender *sender) {
        id<RTCDtmfSender> dtmf = sender.dtmfSender;
        resolve(@{
            @"remainingSymbols": @([dtmf remainingTones].length),
            @"canInsert": @(dtmf.canInsertDtmf),
            @"audioTrackEnabled": @(sender.track.isEnabled),
            @"durationMs": @([dtmf duration] * 1000),
            @"interToneGapMs": @([dtmf interToneGap] * 1000),
        });
    }];
}
@end
