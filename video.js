// ============================================================
// EpicTalk - WebRTC Video Calls Module
// Signaling via Supabase Realtime + calls table
// ============================================================

const Video = {

  pc:          null,   // RTCPeerConnection
  localStream: null,   // MediaStream (camera + mic)
  screenStream: null,  // MediaStream (screen share)
  callChannel: null,   // Supabase realtime channel for signaling
  callTimer:   null,   // Interval for call duration
  callSeconds: 0,
  isMuted:     false,
  isCamOff:    false,
  isScreenSharing: false,

  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
    // Add TURN servers for production:
    // { urls: 'turn:your-turn-server.com', username: '...', credential: '...' }
  ],

  // ============================================================
  // START CALL (initiator)
  // ============================================================

  async startCall(roomId, type = 'video') {
    if (!AppState.user || !roomId) return;

    // Check if already in a call
    if (AppState.call.status === 'active' || AppState.call.status === 'ringing') {
      UI.showToast('أنت في مكالمة بالفعل', 'warning'); return;
    }

    try {
      // Get local media
      await this.getLocalMedia(type);

      // Create call record in DB
      const { data: call, error } = await db.from('calls').insert({
        room_id:      roomId,
        initiated_by: AppState.user.id,
        type,
        status:       'ringing'
      }).select().single();

      if (error) throw error;

      AppState.call = {
        id:          call.id,
        roomId,
        type,
        status:      'ringing',
        initiatedBy: AppState.user.id,
        isInitiator: true
      };

      // Show calling UI
      this.showCallingUI(call);

      // Subscribe to call channel for answer/ICE
      this.subscribeToCallChannel(call.id, true);

      // Create peer connection
      this.createPeerConnection();

      // Create SDP offer
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: type === 'video'
      });
      await this.pc.setLocalDescription(offer);

      // Save offer to DB
      await db.from('calls')
        .update({ sdp_offer: { type: offer.type, sdp: offer.sdp } })
        .eq('id', call.id);

      // Send call notification to room members
      const rd = AppState.rooms.find(r => r.room.id === roomId);
      const senderName = AppState.profile?.full_name || AppState.profile?.username || 'شخص ما';
      const { data: members } = await db.from('room_members').select('user_id')
        .eq('room_id', roomId).neq('user_id', AppState.user.id);

      if (members?.length) {
        await db.from('notifications').insert(members.map(m => ({
          user_id: m.user_id,
          type:    'call',
          title:   `📹 مكالمة واردة من ${senderName}`,
          body:    `${type === 'video' ? 'مكالمة فيديو' : 'مكالمة صوتية'}`,
          data:    { call_id: call.id, room_id: roomId }
        })));
      }

    } catch (err) {
      console.error('startCall error:', err);
      UI.showToast('فشل بدء المكالمة: ' + err.message, 'error');
      this.cleanup();
    }
  },

  // ============================================================
  // ACCEPT CALL (receiver)
  // ============================================================

  async acceptCall(callId) {
    UI.closeModal('modal-incoming-call');

    try {
      // Get call details
      const { data: call, error } = await db.from('calls').select('*').eq('id', callId).single();
      if (error || !call) throw new Error('Call not found');
      if (call.status !== 'ringing') { UI.showToast('انتهت المكالمة', 'info'); return; }

      // Get local media
      await this.getLocalMedia(call.type);

      AppState.call = {
        id:          call.id,
        roomId:      call.room_id,
        type:        call.type,
        status:      'active',
        initiatedBy: call.initiated_by,
        isInitiator: false
      };

      // Subscribe to call channel
      this.subscribeToCallChannel(call.id, false);

      // Create peer connection
      this.createPeerConnection();

      // Set remote description (offer)
      if (call.sdp_offer) {
        await this.pc.setRemoteDescription(new RTCSessionDescription(call.sdp_offer));
      }

      // Create answer
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      // Save answer to DB + update status
      await db.from('calls').update({
        sdp_answer: { type: answer.type, sdp: answer.sdp },
        status:     'active'
      }).eq('id', call.id);

      this.showActiveCallUI(call);
      this.startTimer();

    } catch (err) {
      console.error('acceptCall error:', err);
      UI.showToast('فشل قبول المكالمة: ' + err.message, 'error');
      this.cleanup();
    }
  },

  // ============================================================
  // DECLINE CALL
  // ============================================================

  async declineCall(callId) {
    UI.closeModal('modal-incoming-call');
    await db.from('calls').update({ status: 'declined', ended_at: new Date().toISOString() }).eq('id', callId);
    UI.showToast('تم رفض المكالمة', 'info');
  },

  // ============================================================
  // END CALL
  // ============================================================

  async endCall() {
    if (!AppState.call.id) return;

    await db.from('calls').update({
      status:      'ended',
      ended_at:    new Date().toISOString(),
      duration_sec: this.callSeconds
    }).eq('id', AppState.call.id);

    // Send call message to chat
    if (AppState.call.roomId) {
      await db.from('messages').insert({
        room_id:   AppState.call.roomId,
        sender_id: AppState.user.id,
        content:   `مكالمة ${AppState.call.type === 'video' ? 'فيديو' : 'صوتية'} - ${UI.formatDuration(this.callSeconds)}`,
        type:      'call',
        metadata:  { type: AppState.call.type, duration: this.callSeconds, status: 'ended' }
      });
    }

    this.cleanup();
    this.hideCallUI();
    UI.showToast(`انتهت المكالمة • ${UI.formatDuration(this.callSeconds)}`, 'info');
  },

  // ============================================================
  // PEER CONNECTION
  // ============================================================

  createPeerConnection() {
    this.pc = new RTCPeerConnection({ iceServers: this.ICE_SERVERS });

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => this.pc.addTrack(track, this.localStream));
    }

    // ICE candidate handler
    this.pc.onicecandidate = async ({ candidate }) => {
      if (candidate && this.callChannel) {
        this.callChannel.send({
          type:    'broadcast',
          event:   'ice-candidate',
          payload: { candidate: candidate.toJSON() }
        });
      }
    };

    // Remote stream handler
    this.pc.ontrack = ({ streams }) => {
      if (streams?.[0]) {
        const remoteVideo = document.getElementById('remote-video');
        if (remoteVideo) remoteVideo.srcObject = streams[0];
      }
    };

    // Connection state changes
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      console.log('WebRTC connection state:', state);
      if (state === 'connected') {
        AppState.call.status = 'active';
        document.getElementById('call-status-text')?.textContent && (
          document.getElementById('call-status-text').textContent = 'متصل ●'
        );
        this.startTimer();
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.endCall();
      }
    };

    // ICE connection state
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') {
        this.pc.restartIce();
      }
    };

    return this.pc;
  },

  // ============================================================
  // SUPABASE SIGNALING CHANNEL
  // ============================================================

  subscribeToCallChannel(callId, isInitiator) {
    if (this.callChannel) db.removeChannel(this.callChannel);

    this.callChannel = db.channel(`call:${callId}`, {
      config: { broadcast: { self: false } }
    })
    .on('broadcast', { event: 'ice-candidate' }, ({ payload }) => {
      if (this.pc && payload?.candidate) {
        this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
          .catch(err => console.error('addIceCandidate error:', err));
      }
    })
    .on('postgres_changes', {
      event:  'UPDATE',
      schema: 'public',
      table:  'calls',
      filter: `id=eq.${callId}`
    }, async payload => {
      const call = payload.new;

      if (call.status === 'declined' || call.status === 'missed') {
        this.cleanup();
        this.hideCallUI();
        UI.showToast(call.status === 'declined' ? 'تم رفض المكالمة' : 'لم يُرَد على المكالمة', 'info');
        return;
      }

      if (call.status === 'ended') {
        this.cleanup();
        this.hideCallUI();
        return;
      }

      // Initiator: handle answer
      if (isInitiator && call.sdp_answer && this.pc && !this.pc.remoteDescription) {
        try {
          await this.pc.setRemoteDescription(new RTCSessionDescription(call.sdp_answer));
          this.showActiveCallUI(call);
        } catch (err) {
          console.error('setRemoteDescription error:', err);
        }
      }
    })
    .subscribe();

    AppState.channels[`call:${callId}`] = this.callChannel;
  },

  // ============================================================
  // MEDIA CONTROLS
  // ============================================================

  async getLocalMedia(type) {
    try {
      const constraints = {
        audio: true,
        video: type === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
      };
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      const localVideo = document.getElementById('local-video');
      if (localVideo) localVideo.srcObject = this.localStream;
      return this.localStream;
    } catch (err) {
      if (err.name === 'NotAllowedError') throw new Error('لم يتم منح إذن الكاميرا أو المايكروفون');
      if (err.name === 'NotFoundError')   throw new Error('لم يتم العثور على كاميرا أو مايكروفون');
      throw err;
    }
  },

  toggleMute() {
    if (!this.localStream) return;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(t => t.enabled = !this.isMuted);
    const btn = document.getElementById('btn-mute');
    if (btn) btn.textContent = this.isMuted ? '🔇' : '🎙';
    btn?.classList.toggle('control-off', this.isMuted);
  },

  toggleCamera() {
    if (!this.localStream) return;
    this.isCamOff = !this.isCamOff;
    this.localStream.getVideoTracks().forEach(t => t.enabled = !this.isCamOff);
    const btn = document.getElementById('btn-camera');
    if (btn) btn.textContent = this.isCamOff ? '📷' : '📹';
    btn?.classList.toggle('control-off', this.isCamOff);
    const localVideo = document.getElementById('local-video');
    if (localVideo) localVideo.style.opacity = this.isCamOff ? '0' : '1';
  },

  async toggleScreen() {
    if (this.isScreenSharing) {
      // Stop screen sharing, revert to camera
      this.screenStream?.getTracks().forEach(t => t.stop());
      this.screenStream = null;
      this.isScreenSharing = false;

      const videoTrack = this.localStream?.getVideoTracks()[0];
      if (videoTrack && this.pc) {
        const sender = this.pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(videoTrack);
      }
      document.getElementById('btn-screen')?.classList.remove('control-on');
      UI.showToast('توقف مشاركة الشاشة', 'info');
    } else {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        this.isScreenSharing = true;
        const screenTrack = this.screenStream.getVideoTracks()[0];

        if (screenTrack && this.pc) {
          const sender = this.pc.getSenders().find(s => s.track?.kind === 'video');
          if (sender) await sender.replaceTrack(screenTrack);
        }

        // Stop screen sharing if user stops via browser UI
        screenTrack.onended = () => this.toggleScreen();
        document.getElementById('btn-screen')?.classList.add('control-on');
        UI.showToast('جاري مشاركة الشاشة', 'success');
      } catch (err) {
        if (err.name !== 'NotAllowedError') UI.showToast('فشل مشاركة الشاشة', 'error');
      }
    }
  },

  // ============================================================
  // CALL TIMER
  // ============================================================

  startTimer() {
    this.callSeconds = 0;
    clearInterval(this.callTimer);
    this.callTimer = setInterval(() => {
      this.callSeconds++;
      const el = document.getElementById('call-timer');
      if (el) el.textContent = UI.formatDuration(this.callSeconds);
    }, 1000);
  },

  // ============================================================
  // UI
  // ============================================================

  showIncomingCall(call) {
    AppState.call.id = call.id;

    // Get caller info
    db.from('profiles').select('*').eq('id', call.initiated_by).single()
      .then(({ data: caller }) => {
        const modal = document.getElementById('modal-incoming-call');
        if (!modal) return;

        document.getElementById('caller-avatar').innerHTML = caller
          ? UI.avatarHtml(caller, 72) : UI.initialsAvatar('?', 72);
        document.getElementById('caller-name').textContent =
          caller?.full_name || caller?.username || 'شخص ما';
        document.getElementById('call-type-label').textContent =
          call.type === 'video' ? '📹 مكالمة فيديو واردة' : '📞 مكالمة صوتية واردة';

        document.getElementById('btn-accept-call').onclick = () => this.acceptCall(call.id);
        document.getElementById('btn-decline-call').onclick = () => this.declineCall(call.id);

        UI.openModal('modal-incoming-call');

        // Auto-decline after 30s
        setTimeout(() => {
          if (AppState.call.status === 'ringing') {
            this.declineCall(call.id);
            UI.closeModal('modal-incoming-call');
          }
        }, 30000);

        // Play ringtone
        this.playRingtone();
      });
  },

  showCallingUI(call) {
    const overlay = document.getElementById('video-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';

    document.getElementById('call-status-text').textContent = 'جاري الاتصال...';
    document.getElementById('btn-end-call').onclick = () => this.endCall();

    // Hide remote video, show calling state
    document.getElementById('remote-video').style.display = 'none';
    document.getElementById('calling-indicator').style.display = 'flex';
  },

  showActiveCallUI(call) {
    document.getElementById('remote-video').style.display = 'block';
    document.getElementById('calling-indicator').style.display = 'none';
    document.getElementById('call-status-text').textContent = 'متصل ●';
    this.stopRingtone();
    AppState.call.status = 'active';
  },

  hideCallUI() {
    const overlay = document.getElementById('video-overlay');
    if (overlay) overlay.style.display = 'none';
    AppState.call = { id: null, roomId: null, type: 'video', status: null, initiatedBy: null, isInitiator: false };
  },

  // ============================================================
  // RINGTONE
  // ============================================================

  ringtoneInterval: null,
  audioCtx: null,

  playRingtone() {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      let step = 0;
      const notes = [880, 1108, 880, 1108];
      this.ringtoneInterval = setInterval(() => {
        const osc  = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.frequency.value = notes[step % notes.length];
        gain.gain.setValueAtTime(0.15, this.audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.4);
        osc.start(this.audioCtx.currentTime);
        osc.stop(this.audioCtx.currentTime + 0.4);
        step++;
      }, 600);
    } catch (_) {}
  },

  stopRingtone() {
    clearInterval(this.ringtoneInterval);
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  },

  // ============================================================
  // CLEANUP
  // ============================================================

  cleanup() {
    clearInterval(this.callTimer);
    this.stopRingtone();

    // Stop all tracks
    this.localStream?.getTracks().forEach(t => t.stop());
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.localStream  = null;
    this.screenStream = null;
    this.isScreenSharing = false;
    this.isMuted      = false;
    this.isCamOff     = false;
    this.callSeconds  = 0;

    // Close peer connection
    this.pc?.close();
    this.pc = null;

    // Remove call channel
    if (this.callChannel) {
      db.removeChannel(this.callChannel);
      this.callChannel = null;
    }

    // Clear video elements
    const local  = document.getElementById('local-video');
    const remote = document.getElementById('remote-video');
    if (local)  local.srcObject  = null;
    if (remote) remote.srcObject = null;
  }
};

