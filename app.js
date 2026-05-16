// ============================================================
// EpicTalk - Main Application Logic
// ============================================================

const App = {

  // ============================================================
  // INITIALIZATION
  // ============================================================

  async init() {
    // Auth guard
    const user = await Auth.getUser();
    if (!user) { window.location.href = 'index.html'; return; }
    AppState.user = user;

    // Load profile
    await this.loadUserProfile();

    // Setup UI
    this.renderUserMini();
    this.setupEventListeners();

    // Load data
    await this.loadRooms();
    await this.loadNotifications();

    // Start realtime
    this.subscribeToNotifications();
    this.subscribeToPresence();

    // Update online status
    await this.updatePresence('online');

    // Handle browser close
    window.addEventListener('beforeunload', () => {
      this.updatePresence('offline');
    });

    // Show welcome
    UI.showToast(`مرحباً ${AppState.profile?.full_name || AppState.profile?.username} 👋`, 'success');
  },

  // ============================================================
  // PROFILE
  // ============================================================

  async loadUserProfile() {
    const { data, error } = await Auth.getProfile(AppState.user.id);
    if (!error && data) AppState.profile = data;
  },

  renderUserMini() {
    const p = AppState.profile;
    if (!p) return;

    const el = document.getElementById('user-mini');
    if (!el) return;

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;
                  border-radius:20px;background:rgba(255,255,255,.05);
                  border:1px solid rgba(255,255,255,.08);cursor:pointer;"
           onclick="UI.openModal('modal-profile')">
        <div style="position:relative">
          ${UI.avatarHtml(p, 44)}
          <span class="presence-dot status-${p.status || 'offline'}"
                style="position:absolute;bottom:-2px;left:-2px;"></span>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:.95rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${UI.escapeHtml(p.full_name || p.username || 'مستخدم')}
          </div>
          <div style="color:var(--muted);font-size:.8rem">@${UI.escapeHtml(p.username || '')}</div>
        </div>
        <button onclick="event.stopPropagation();App.openSettings()" title="الإعدادات"
                style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.1rem;padding:6px">⚙️</button>
      </div>`;
  },

  // ============================================================
  // ROOMS / CONVERSATIONS
  // ============================================================

  async loadRooms() {
    document.getElementById('conversations-list').innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--muted)"><span class="spinner"></span></div>';

    // Get rooms where user is a member
    const { data: memberships, error } = await db
      .from('room_members')
      .select(`
        room_id, role, last_read_at,
        rooms (id, name, description, type, avatar_url, created_at, updated_at)
      `)
      .eq('user_id', AppState.user.id)
      .order('joined_at', { ascending: false });

    if (error) { console.error('loadRooms error:', error); return; }

    // For each room, get last message + unread count
    const roomData = await Promise.all((memberships || []).map(async m => {
      const room = m.rooms;

      const { data: lastMsgs } = await db
        .from('messages')
        .select('id, content, type, sender_id, created_at, profiles(username, full_name)')
        .eq('room_id', room.id)
        .order('created_at', { ascending: false })
        .limit(1);

      const lastMessage = lastMsgs?.[0] || null;

      // Unread count
      const { data: unreadData } = await db
        .rpc('get_unread_count', { p_room_id: room.id, p_user_id: AppState.user.id });

      const unread = unreadData || 0;
      AppState.unreadCounts[room.id] = unread;

      // For direct chats, get the other user's profile
      let displayName  = room.name;
      let displayProfile = null;
      if (room.type === 'direct') {
        const { data: otherMember } = await db
          .from('room_members')
          .select('profiles(id, username, full_name, avatar_url, status)')
          .eq('room_id', room.id)
          .neq('user_id', AppState.user.id)
          .single();
        displayProfile = otherMember?.profiles || null;
        displayName    = displayProfile?.full_name || displayProfile?.username || room.name || 'محادثة مباشرة';
      }

      return { room, lastMessage, unread, displayName, displayProfile, membership: m };
    }));

    AppState.rooms = roomData.sort((a, b) => {
      const ta = new Date(a.lastMessage?.created_at || a.room.created_at);
      const tb = new Date(b.lastMessage?.created_at || b.room.created_at);
      return tb - ta;
    });

    this.renderConversationsList();
    this.updateUnreadBadge();
  },

  renderConversationsList() {
    const container = document.getElementById('conversations-list');
    if (!container) return;

    if (!AppState.rooms.length) {
      container.innerHTML = `
        <div style="padding:40px 20px;text-align:center;color:var(--muted)">
          <div style="font-size:3rem;margin-bottom:12px">💬</div>
          <div style="font-size:.95rem">لا توجد محادثات بعد</div>
          <div style="font-size:.85rem;margin-top:6px">ابدأ محادثة جديدة!</div>
        </div>`;
      return;
    }

    container.innerHTML = AppState.rooms.map(rd => this.renderConversationItem(rd)).join('');
  },

  renderConversationItem(rd) {
    const { room, lastMessage, unread, displayName, displayProfile } = rd;
    const isActive  = AppState.currentRoomId === room.id;
    const isOnline  = displayProfile ? AppState.onlineUsers.has(displayProfile.id) : false;

    let lastMsgText = 'لا توجد رسائل بعد';
    if (lastMessage) {
      if (lastMessage.type === 'image') lastMsgText = '📷 صورة';
      else if (lastMessage.type === 'file') lastMsgText = '📎 ملف';
      else if (lastMessage.type === 'call') lastMsgText = '📹 مكالمة';
      else lastMsgText = lastMessage.content.substring(0, 42) + (lastMessage.content.length > 42 ? '...' : '');
    }

    const avatarHtml = room.type === 'direct' && displayProfile
      ? UI.avatarHtml(displayProfile, 48)
      : UI.initialsAvatar(displayName, 48);

    return `
      <div class="conv-item ${isActive ? 'active' : ''}" onclick="App.openRoom('${room.id}')" data-room-id="${room.id}">
        <div style="position:relative">
          ${avatarHtml}
          ${isOnline ? '<span class="presence-dot status-online" style="position:absolute;bottom:0;left:0"></span>' : ''}
          ${room.type === 'group' ? '<span style="position:absolute;bottom:-2px;left:-2px;font-size:.7rem">👥</span>' : ''}
        </div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">
              ${UI.escapeHtml(displayName)}
            </span>
            <span style="color:var(--muted);font-size:.78rem;flex-shrink:0">
              ${lastMessage ? UI.formatTime(lastMessage.created_at) : ''}
            </span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="color:var(--muted);font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px">
              ${UI.escapeHtml(lastMsgText)}
            </span>
            ${unread > 0
              ? `<span class="count" style="font-size:.75rem;padding:3px 8px">${unread > 99 ? '99+' : unread}</span>`
              : ''}
          </div>
        </div>
      </div>`;
  },

  // ============================================================
  // OPEN ROOM / MESSAGES
  // ============================================================

  async openRoom(roomId) {
    if (AppState.currentRoomId === roomId) return;

    // Update active state in sidebar
    document.querySelectorAll('.conv-item').forEach(el => {
      el.classList.toggle('active', el.dataset.roomId === roomId);
    });

    AppState.currentRoomId = roomId;
    this.showChatView();

    const rd = AppState.rooms.find(r => r.room.id === roomId);
    if (rd) this.updateChatHeader(rd);

    // Load messages
    document.getElementById('messages-container').innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--muted)"><span class="spinner"></span></div>';

    await this.loadMessages(roomId);
    this.subscribeToMessages(roomId);

    // Mark as read
    await db.from('room_members')
      .update({ last_read_at: new Date().toISOString() })
      .eq('room_id', roomId)
      .eq('user_id', AppState.user.id);

    AppState.unreadCounts[roomId] = 0;
    this.updateUnreadBadge();

    // Update sidebar item
    const item = document.querySelector(`[data-room-id="${roomId}"]`);
    if (item) item.querySelector('.count')?.remove();

    // Update right panel
    this.renderRightPanel(rd);
  },

  async loadMessages(roomId) {
    const { data, error } = await db
      .from('messages')
      .select(`
        id, content, type, metadata, edited, created_at, sender_id,
        profiles (id, username, full_name, avatar_url)
      `)
      .eq('room_id', roomId)
      .order('created_at', { ascending: true })
      .limit(60);

    if (error) { console.error('loadMessages error:', error); return; }

    AppState.messages[roomId] = data || [];
    this.renderMessages(roomId);
    UI.scrollToBottom('messages-container', false);
  },

  renderMessages(roomId) {
    const container = document.getElementById('messages-container');
    if (!container) return;

    const messages = AppState.messages[roomId] || [];
    if (!messages.length) {
      container.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                    height:100%;color:var(--muted);gap:12px">
          <div style="font-size:3.5rem">👋</div>
          <div style="font-size:1rem">ابدأ المحادثة!</div>
        </div>`;
      return;
    }

    // Group messages by date
    let lastDate  = null;
    let lastSender = null;
    let html = '';

    messages.forEach((msg, idx) => {
      const msgDate  = new Date(msg.created_at).toDateString();
      const isOwn    = msg.sender_id === AppState.user.id;
      const showDate = msgDate !== lastDate;
      const showAvatar = !isOwn && (lastSender !== msg.sender_id || showDate);

      if (showDate) {
        lastDate = msgDate;
        const label = this.getDateLabel(msg.created_at);
        html += `<div class="date-divider"><span>${label}</span></div>`;
      }

      html += this.renderMessage(msg, isOwn, showAvatar);
      lastSender = msg.sender_id;
    });

    container.innerHTML = html;

    // Attach context menus
    container.querySelectorAll('.msg-bubble').forEach(el => {
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        const msgId = el.dataset.msgId;
        const isOwn  = el.dataset.own === 'true';
        this.showMessageMenu(e, msgId, isOwn);
      });
    });
  },

  renderMessage(msg, isOwn, showAvatar = true) {
    const profile  = msg.profiles;
    const timeStr  = UI.formatFullTime(msg.created_at);
    const senderName = profile?.full_name || profile?.username || 'مجهول';

    let contentHtml = '';
    if (msg.type === 'image') {
      contentHtml = `<img src="${UI.escapeHtml(msg.content)}" style="max-width:100%;border-radius:10px;cursor:pointer"
                          onclick="App.openImage('${UI.escapeHtml(msg.content)}')" loading="lazy">`;
    } else if (msg.type === 'file') {
      const meta = msg.metadata || {};
      contentHtml = `
        <a href="${UI.escapeHtml(msg.content)}" target="_blank" rel="noopener"
           style="display:flex;align-items:center;gap:10px;text-decoration:none;color:inherit">
          <span style="font-size:1.8rem">📎</span>
          <div>
            <div style="font-weight:600">${UI.escapeHtml(meta.name || 'ملف')}</div>
            <div style="font-size:.8rem;color:var(--muted)">${meta.size || ''}</div>
          </div>
        </a>`;
    } else if (msg.type === 'call') {
      const meta = msg.metadata || {};
      contentHtml = `
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:1.5rem">${meta.type === 'audio' ? '📞' : '📹'}</span>
          <div>
            <div style="font-weight:600">${meta.status === 'missed' ? 'مكالمة فائتة' : meta.status === 'declined' ? 'مكالمة مرفوضة' : 'مكالمة'} ${meta.type === 'audio' ? 'صوتية' : 'فيديو'}</div>
            ${meta.duration ? `<div style="font-size:.8rem;color:var(--muted)">${UI.formatDuration(meta.duration)}</div>` : ''}
          </div>
        </div>`;
    } else if (msg.type === 'system') {
      return `<div class="date-divider"><span>${UI.escapeHtml(msg.content)}</span></div>`;
    } else {
      contentHtml = `<div>${UI.linkify(msg.content)}</div>`;
    }

    return `
      <div class="msg-row ${isOwn ? 'own' : 'other'}">
        ${!isOwn && showAvatar
          ? `<div style="align-self:flex-end;margin-left:8px">${UI.avatarHtml(profile, 32)}</div>`
          : !isOwn ? '<div style="width:32px;margin-left:8px"></div>' : ''}
        <div>
          ${!isOwn && showAvatar
            ? `<div style="font-size:.78rem;color:var(--muted);margin-bottom:4px;padding-right:4px">${UI.escapeHtml(senderName)}</div>`
            : ''}
          <div class="msg-bubble ${isOwn ? 'msg-own' : 'msg-other'}"
               data-msg-id="${msg.id}" data-own="${isOwn}">
            ${contentHtml}
            <div class="msg-meta">
              <span>${timeStr}</span>
              ${msg.edited ? '<span>✏️ معدّل</span>' : ''}
              ${isOwn ? '<span class="msg-status">✓✓</span>' : ''}
            </div>
          </div>
        </div>
      </div>`;
  },

  appendMessage(msg) {
    const roomId = msg.room_id;
    if (!AppState.messages[roomId]) AppState.messages[roomId] = [];
    AppState.messages[roomId].push(msg);

    if (AppState.currentRoomId === roomId) {
      const wasAtBottom = UI.isScrolledToBottom('messages-container');
      const isOwn = msg.sender_id === AppState.user.id;
      const container = document.getElementById('messages-container');
      if (container) {
        // Remove empty state if present
        const empty = container.querySelector('[data-empty]');
        if (empty) empty.remove();

        const wrapper = document.createElement('div');
        wrapper.innerHTML = this.renderMessage(msg, isOwn, true);
        while (wrapper.firstChild) container.appendChild(wrapper.firstChild);

        if (wasAtBottom || isOwn) UI.scrollToBottom('messages-container');
      }
    }
  },

  // ── Send Message ─────────────────────────────────────────
  async sendMessage(content, type = 'text', metadata = {}) {
    if (!AppState.currentRoomId || !content.trim()) return;

    const msg = {
      room_id:   AppState.currentRoomId,
      sender_id: AppState.user.id,
      content:   content.trim(),
      type,
      metadata
    };

    const { data, error } = await db.from('messages').insert(msg).select(`
      id, content, type, metadata, edited, created_at, sender_id,
      profiles (id, username, full_name, avatar_url)
    `).single();

    if (error) { UI.showToast('فشل إرسال الرسالة', 'error'); return; }

    // Send notification to room members
    this.notifyRoomMembers(AppState.currentRoomId, data);

    // Update last message in sidebar
    this.updateRoomLastMessage(AppState.currentRoomId, data);
  },

  async sendFile(file) {
    if (!AppState.currentRoomId) return;

    const maxSize = 20 * 1024 * 1024;
    if (file.size > maxSize) { UI.showToast('حجم الملف يجب أن يكون أقل من 20MB', 'warning'); return; }

    UI.showToast('جاري رفع الملف...', 'info');

    const isImage = file.type.startsWith('image/');
    const ext     = file.name.split('.').pop();
    const fileName = `${AppState.user.id}/${Date.now()}.${ext}`;
    const bucket   = 'attachments';

    const { error: upErr } = await db.storage.from(bucket).upload(fileName, file, { contentType: file.type });
    if (upErr) { UI.showToast('فشل رفع الملف', 'error'); return; }

    const { data: { publicUrl } } = db.storage.from(bucket).getPublicUrl(fileName);

    await this.sendMessage(publicUrl, isImage ? 'image' : 'file', {
      name: file.name,
      size: this.formatFileSize(file.size),
      mime: file.type
    });
    UI.showToast('تم رفع الملف بنجاح', 'success');
  },

  formatFileSize(bytes) {
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1048576)    return `${(bytes/1024).toFixed(1)} KB`;
    return `${(bytes/1048576).toFixed(1)} MB`;
  },

  // ── Notify room members ──────────────────────────────────
  async notifyRoomMembers(roomId, message) {
    const { data: members } = await db
      .from('room_members')
      .select('user_id')
      .eq('room_id', roomId)
      .neq('user_id', AppState.user.id);

    if (!members?.length) return;

    const rd = AppState.rooms.find(r => r.room.id === roomId);
    const senderName = AppState.profile?.full_name || AppState.profile?.username || 'شخص ما';
    const roomName   = rd?.displayName || rd?.room?.name || 'غرفة';

    const notifications = members.map(m => ({
      user_id: m.user_id,
      type:    'message',
      title:   `رسالة من ${senderName}`,
      body:    `في ${roomName}: ${message.content.substring(0, 60)}`,
      data:    { room_id: roomId, message_id: message.id }
    }));

    await db.from('notifications').insert(notifications);
  },

  updateRoomLastMessage(roomId, msg) {
    const rd = AppState.rooms.find(r => r.room.id === roomId);
    if (rd) rd.lastMessage = msg;
    // Re-sort and re-render sidebar
    AppState.rooms.sort((a, b) => {
      const ta = new Date(a.lastMessage?.created_at || a.room.created_at);
      const tb = new Date(b.lastMessage?.created_at || b.room.created_at);
      return tb - ta;
    });
    this.renderConversationsList();
  },

  // ============================================================
  // NOTIFICATIONS
  // ============================================================

  async loadNotifications() {
    const { data, error } = await db
      .from('notifications')
      .select('*')
      .eq('user_id', AppState.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (!error) AppState.notifications = data || [];
    this.renderNotifications();
    this.updateNotifBadge();
  },

  renderNotifications() {
    const list = document.getElementById('notif-list');
    if (!list) return;

    if (!AppState.notifications.length) {
      list.innerHTML = `
        <div style="padding:30px;text-align:center;color:var(--muted)">
          <div style="font-size:2.5rem;margin-bottom:10px">🔔</div>
          <div>لا توجد إشعارات</div>
        </div>`;
      return;
    }

    const icons = { message:'💬', call:'📹', group_invite:'👥', mention:'@', system:'ℹ️' };
    list.innerHTML = AppState.notifications.map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}" onclick="App.handleNotifClick('${n.id}','${n.type}','${JSON.stringify(n.data).replace(/"/g,'&quot;')}')">
        <div class="notif-icon">${icons[n.type] || 'ℹ️'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:${n.read ? '500' : '700'};font-size:.9rem">${UI.escapeHtml(n.title)}</div>
          <div style="color:var(--muted);font-size:.82rem;margin-top:3px">${UI.escapeHtml(n.body || '')}</div>
          <div style="color:var(--muted);font-size:.78rem;margin-top:4px">${UI.formatTime(n.created_at)}</div>
        </div>
        ${!n.read ? '<span class="notif-dot"></span>' : ''}
      </div>`).join('');
  },

  async handleNotifClick(id, type, dataStr) {
    await this.markNotificationRead(id);
    try {
      const data = JSON.parse(dataStr.replace(/&quot;/g, '"'));
      if ((type === 'message' || type === 'mention') && data.room_id) {
        UI.closeModal('modal-notifications');
        await this.openRoom(data.room_id);
      }
    } catch (_) {}
  },

  async markNotificationRead(id) {
    await db.from('notifications').update({ read: true }).eq('id', id);
    const notif = AppState.notifications.find(n => n.id === id);
    if (notif) notif.read = true;
    this.renderNotifications();
    this.updateNotifBadge();
  },

  async markAllNotificationsRead() {
    await db.from('notifications').update({ read: true }).eq('user_id', AppState.user.id).eq('read', false);
    AppState.notifications.forEach(n => n.read = true);
    this.renderNotifications();
    this.updateNotifBadge();
  },

  updateNotifBadge() {
    const unread = AppState.notifications.filter(n => !n.read).length;
    const badge  = document.getElementById('notif-badge');
    if (!badge) return;
    if (unread > 0) {
      badge.textContent = unread > 99 ? '99+' : unread;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  },

  updateUnreadBadge() {
    const total = Object.values(AppState.unreadCounts).reduce((a, b) => a + b, 0);
    const badge = document.getElementById('total-unread');
    if (!badge) return;
    badge.textContent = total > 99 ? '99+' : total;
    badge.style.display = total > 0 ? 'flex' : 'none';
  },

  // ============================================================
  // REALTIME SUBSCRIPTIONS
  // ============================================================

  subscribeToMessages(roomId) {
    // Remove old subscription for this room
    if (AppState.channels[`msg-${roomId}`]) {
      db.removeChannel(AppState.channels[`msg-${roomId}`]);
    }

    AppState.channels[`msg-${roomId}`] = db
      .channel(`room-messages:${roomId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table:  'messages',
        filter: `room_id=eq.${roomId}`
      }, async payload => {
        // Fetch full message with profile
        const { data: msg } = await db
          .from('messages')
          .select('id, content, type, metadata, edited, created_at, sender_id, profiles(id, username, full_name, avatar_url)')
          .eq('id', payload.new.id)
          .single();

        if (msg && msg.sender_id !== AppState.user.id) {
          this.appendMessage({ ...msg, room_id: roomId });
          // Mark read if room is open
          if (AppState.currentRoomId === roomId) {
            await db.from('room_members')
              .update({ last_read_at: new Date().toISOString() })
              .eq('room_id', roomId).eq('user_id', AppState.user.id);
          }
        }
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table:  'messages',
        filter: `room_id=eq.${roomId}`
      }, payload => {
        // Update edited message in DOM
        const bubble = document.querySelector(`[data-msg-id="${payload.new.id}"]`);
        if (bubble) {
          const textDiv = bubble.querySelector('div:first-child');
          if (textDiv && payload.new.type === 'text') {
            textDiv.innerHTML = UI.linkify(payload.new.content);
          }
        }
      })
      .subscribe();
  },

  subscribeToNotifications() {
    AppState.channels['notifs'] = db
      .channel('user-notifications')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table:  'notifications',
        filter: `user_id=eq.${AppState.user.id}`
      }, payload => {
        AppState.notifications.unshift(payload.new);
        this.renderNotifications();
        this.updateNotifBadge();

        // Browser notification
        if (Notification?.permission === 'granted') {
          new Notification(payload.new.title, {
            body: payload.new.body,
            icon: '/favicon.ico'
          });
        }
      })
      .subscribe();
  },

  subscribeToPresence() {
    AppState.channels['presence'] = db
      .channel('online-users', {
        config: { presence: { key: AppState.user.id } }
      })
      .on('presence', { event: 'sync' }, () => {
        const state = AppState.channels['presence'].presenceState();
        AppState.onlineUsers.clear();
        Object.keys(state).forEach(key => AppState.onlineUsers.add(key));
        this.renderConversationsList(); // refresh online dots
      })
      .on('presence', { event: 'join' }, ({ key }) => {
        AppState.onlineUsers.add(key);
      })
      .on('presence', { event: 'leave' }, ({ key }) => {
        AppState.onlineUsers.delete(key);
      })
      .subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          await AppState.channels['presence'].track({
            user_id: AppState.user.id,
            status:  'online'
          });
        }
      });
  },

  // Also subscribe to incoming calls
  subscribeToIncomingCalls() {
    AppState.channels['calls'] = db
      .channel('incoming-calls')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table:  'calls'
      }, async payload => {
        const call = payload.new;
        if (call.initiated_by === AppState.user.id) return;

        // Check if we're a member of this room
        const { data: member } = await db.from('room_members')
          .select('user_id').eq('room_id', call.room_id).eq('user_id', AppState.user.id).single();

        if (!member) return;

        // Show incoming call UI
        Video.showIncomingCall(call);
      })
      .subscribe();
  },

  // ============================================================
  // PRESENCE
  // ============================================================

  async updatePresence(status) {
    if (!AppState.user) return;
    await db.from('profiles')
      .update({ status, last_seen: new Date().toISOString() })
      .eq('id', AppState.user.id);
    if (AppState.profile) AppState.profile.status = status;
  },

  // ============================================================
  // ROOMS MANAGEMENT
  // ============================================================

  async createDirectMessage(targetUserId) {
    // Check if DM already exists
    const existingRoom = AppState.rooms.find(rd =>
      rd.room.type === 'direct' && rd.displayProfile?.id === targetUserId
    );
    if (existingRoom) {
      UI.closeAllModals();
      await this.openRoom(existingRoom.room.id);
      return;
    }

    // Generate ID client-side to avoid RLS SELECT issue after INSERT
    const roomId = crypto.randomUUID();

    const { error: roomErr } = await db
      .from('rooms')
      .insert({ id: roomId, type: 'direct', created_by: AppState.user.id });

    if (roomErr) {
      UI.showToast('فشل إنشاء المحادثة: ' + roomErr.message, 'error');
      return;
    }

    // Add members one by one to avoid RLS batch issue
    await db.from('room_members').insert(
      { room_id: roomId, user_id: AppState.user.id, role: 'admin' }
    );
    await db.from('room_members').insert(
      { room_id: roomId, user_id: targetUserId, role: 'member' }
    );

    UI.closeAllModals();
    await this.loadRooms();
    await this.openRoom(roomId);
    UI.showToast('تم إنشاء المحادثة', 'success');
  },

  async createGroup(name, description, memberIds) {
    if (!name?.trim()) { UI.showToast('أدخل اسم المجموعة', 'warning'); return null; }

    // Generate ID client-side to avoid RLS SELECT issue after INSERT
    const roomId = crypto.randomUUID();

    const { error } = await db.from('rooms').insert({
      id: roomId,
      name: name.trim(),
      description: description?.trim() || '',
      type: 'group',
      created_by: AppState.user.id
    });

    if (error) {
      UI.showToast('فشل إنشاء المجموعة: ' + error.message, 'error');
      return null;
    }

    // Add creator first, then other members
    await db.from('room_members').insert(
      { room_id: roomId, user_id: AppState.user.id, role: 'admin' }
    );

    if (memberIds.length > 0) {
      await db.from('room_members').insert(
        memberIds.map(uid => ({ room_id: roomId, user_id: uid, role: 'member' }))
      );
    }

    // System message
    await db.from('messages').insert({
      room_id: roomId, sender_id: AppState.user.id,
      content: `تم إنشاء مجموعة "${name.trim()}"`, type: 'system'
    });

    await this.loadRooms();
    await this.openRoom(roomId);
    UI.showToast(`تم إنشاء مجموعة "${name.trim()}" بنجاح 🎉`, 'success');
    return { id: roomId };
  },

  async leaveRoom(roomId) {
    if (!confirm('هل تريد مغادرة هذه الغرفة؟')) return;

    await db.from('room_members')
      .delete()
      .eq('room_id', roomId)
      .eq('user_id', AppState.user.id);

    AppState.rooms = AppState.rooms.filter(r => r.room.id !== roomId);
    if (AppState.currentRoomId === roomId) {
      AppState.currentRoomId = null;
      this.showEmptyState();
    }
    this.renderConversationsList();
    UI.showToast('غادرت الغرفة', 'info');
  },

  // ============================================================
  // SEARCH
  // ============================================================

  async searchUsers(query) {
    if (!query?.trim() || query.length < 2) return [];

    const { data } = await db
      .from('profiles')
      .select('id, username, full_name, avatar_url, status')
      .or(`username.ilike.%${query}%,full_name.ilike.%${query}%`)
      .neq('id', AppState.user.id)
      .limit(10);

    return data || [];
  },

  async searchConversations(query) {
    if (!query?.trim()) {
      this.renderConversationsList();
      return;
    }
    const filtered = AppState.rooms.filter(rd =>
      rd.displayName?.toLowerCase().includes(query.toLowerCase()) ||
      rd.room.name?.toLowerCase().includes(query.toLowerCase()) ||
      rd.lastMessage?.content?.toLowerCase().includes(query.toLowerCase())
    );
    const container = document.getElementById('conversations-list');
    if (!container) return;
    if (!filtered.length) {
      container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted)">لا نتائج</div>`;
      return;
    }
    container.innerHTML = filtered.map(rd => this.renderConversationItem(rd)).join('');
  },

  // ============================================================
  // UI HELPERS
  // ============================================================

  showChatView() {
    const empty = document.getElementById('empty-state');
    const chat  = document.getElementById('chat-view');
    if (empty) empty.style.display = 'none';
    if (chat)  chat.style.display  = 'flex';
  },

  showEmptyState() {
    const empty = document.getElementById('empty-state');
    const chat  = document.getElementById('chat-view');
    if (empty) empty.style.display = 'flex';
    if (chat)  chat.style.display  = 'none';
  },

  updateChatHeader(rd) {
    const { room, displayName, displayProfile } = rd;
    const el = document.getElementById('chat-header-content');
    if (!el) return;

    const isOnline = displayProfile ? AppState.onlineUsers.has(displayProfile.id) : false;
    const profile  = displayProfile || { full_name: displayName };

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <div style="position:relative">
          ${room.type === 'direct' && displayProfile ? UI.avatarHtml(displayProfile, 44) : UI.initialsAvatar(displayName, 44)}
          ${isOnline ? '<span class="presence-dot status-online" style="position:absolute;bottom:0;left:0"></span>' : ''}
        </div>
        <div>
          <div style="font-weight:700;font-size:1rem">${UI.escapeHtml(displayName)}</div>
          <div style="font-size:.82rem;color:var(--muted)">
            ${room.type === 'group'
              ? `غرفة مجموعة`
              : isOnline ? '<span style="color:var(--success)">● متصل الآن</span>'
                         : `آخر ظهور ${UI.formatTime(displayProfile?.last_seen || '')}`}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="icon-btn" onclick="Video.startCall('${room.id}','audio')" title="مكالمة صوتية">📞</button>
        <button class="icon-btn" onclick="Video.startCall('${room.id}','video')" title="مكالمة فيديو">📹</button>
        <button class="icon-btn" onclick="App.toggleRightPanel()" title="معلومات الغرفة">ℹ️</button>
        <button class="icon-btn" onclick="App.showRoomMenu()" title="المزيد">⋮</button>
      </div>`;
  },

  renderRightPanel(rd) {
    const panel = document.getElementById('right-panel');
    if (!panel) return;
    const { room, displayName, displayProfile } = rd;

    panel.innerHTML = `
      <div style="padding:20px;display:flex;flex-direction:column;gap:16px">
        <div style="text-align:center;padding:20px 0">
          ${room.type === 'direct' && displayProfile ? UI.avatarHtml(displayProfile, 72) : UI.initialsAvatar(displayName, 72)}
          <div style="margin-top:12px;font-weight:700;font-size:1.1rem">${UI.escapeHtml(displayName)}</div>
          ${displayProfile?.bio ? `<div style="color:var(--muted);font-size:.87rem;margin-top:6px">${UI.escapeHtml(displayProfile.bio)}</div>` : ''}
        </div>
        ${room.type === 'group' ? `
          <div>
            <div style="font-weight:700;margin-bottom:10px">الأعضاء</div>
            <div id="members-list">
              <div style="color:var(--muted)"><span class="spinner"></span></div>
            </div>
          </div>` : ''}
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="action-btn" onclick="Video.startCall('${room.id}','video')">📹 بدء مكالمة فيديو</button>
          <button class="action-btn" onclick="Video.startCall('${room.id}','audio')">📞 مكالمة صوتية</button>
          ${room.type === 'group' ? `<button class="action-btn danger" onclick="App.leaveRoom('${room.id}')">🚪 مغادرة المجموعة</button>` : ''}
        </div>
      </div>`;

    if (room.type === 'group') this.loadRoomMembers(room.id);
  },

  async loadRoomMembers(roomId) {
    const { data } = await db
      .from('room_members')
      .select('role, profiles(id, username, full_name, avatar_url, status)')
      .eq('room_id', roomId);

    const el = document.getElementById('members-list');
    if (!el || !data) return;

    el.innerHTML = data.map(m => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        ${UI.avatarHtml(m.profiles, 36)}
        <div style="flex:1">
          <div style="font-size:.9rem;font-weight:600">${UI.escapeHtml(m.profiles?.full_name || m.profiles?.username || '')}</div>
          <div style="font-size:.78rem;color:var(--muted)">${m.role === 'admin' ? '👑 مدير' : 'عضو'}</div>
        </div>
        <span class="presence-dot status-${m.profiles?.status || 'offline'}"></span>
      </div>`).join('');
  },

  toggleRightPanel() {
    const panel = document.getElementById('right-panel');
    if (!panel) return;
    panel.classList.toggle('visible');
  },

  showRoomMenu() {
    const rd = AppState.rooms.find(r => r.room.id === AppState.currentRoomId);
    if (!rd) return;
    // Simple menu using confirm for now
    const choice = prompt('اختر:\n1- مغادرة الغرفة\n2- إلغاء', '2');
    if (choice === '1') this.leaveRoom(AppState.currentRoomId);
  },

  showMessageMenu(e, msgId, isOwn) {
    // Remove existing menu
    document.getElementById('msg-context-menu')?.remove();

    const menu = document.createElement('div');
    menu.id = 'msg-context-menu';
    menu.className = 'context-menu glass';
    menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:1000`;

    menu.innerHTML = `
      <button onclick="App.copyMessage('${msgId}')">📋 نسخ</button>
      ${isOwn ? `<button onclick="App.editMessage('${msgId}')">✏️ تعديل</button>
                 <button onclick="App.deleteMessage('${msgId}')" style="color:var(--danger)">🗑️ حذف</button>` : ''}
      <button onclick="document.getElementById('msg-context-menu')?.remove()">✕ إلغاء</button>`;

    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 100);
  },

  copyMessage(msgId) {
    const roomMsgs = AppState.messages[AppState.currentRoomId] || [];
    const msg = roomMsgs.find(m => m.id === msgId);
    if (msg) navigator.clipboard.writeText(msg.content).then(() => UI.showToast('تم نسخ الرسالة', 'success'));
    document.getElementById('msg-context-menu')?.remove();
  },

  async editMessage(msgId) {
    document.getElementById('msg-context-menu')?.remove();
    const roomMsgs = AppState.messages[AppState.currentRoomId] || [];
    const msg = roomMsgs.find(m => m.id === msgId);
    if (!msg) return;

    const newContent = prompt('تعديل الرسالة:', msg.content);
    if (!newContent || newContent === msg.content) return;

    await db.from('messages').update({ content: newContent, edited: true }).eq('id', msgId);
    msg.content = newContent;
    msg.edited  = true;
    UI.showToast('تم تعديل الرسالة', 'success');
  },

  async deleteMessage(msgId) {
    document.getElementById('msg-context-menu')?.remove();
    if (!confirm('حذف هذه الرسالة؟')) return;

    await db.from('messages').delete().eq('id', msgId);

    const roomMsgs = AppState.messages[AppState.currentRoomId] || [];
    const idx = roomMsgs.findIndex(m => m.id === msgId);
    if (idx !== -1) roomMsgs.splice(idx, 1);

    const bubble = document.querySelector(`[data-msg-id="${msgId}"]`);
    bubble?.closest('.msg-row')?.remove();
    UI.showToast('تم حذف الرسالة', 'success');
  },

  openImage(url) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:grid;place-items:center;cursor:pointer';
    overlay.innerHTML = `<img src="${url}" style="max-width:92vw;max-height:92vh;border-radius:16px;object-fit:contain">`;
    overlay.onclick = () => overlay.remove();
    document.body.appendChild(overlay);
  },

  getDateLabel(dateStr) {
    const date = new Date(dateStr);
    const now  = new Date();
    const d    = Math.floor((now - date) / 86400000);
    if (d === 0) return 'اليوم';
    if (d === 1) return 'أمس';
    return date.toLocaleDateString('ar', { year: 'numeric', month: 'long', day: 'numeric' });
  },

  openSettings() {
    // Populate profile form
    document.getElementById('settings-name').value       = AppState.profile?.full_name || '';
    document.getElementById('settings-username').value   = AppState.profile?.username || '';
    document.getElementById('settings-bio').value        = AppState.profile?.bio || '';
    UI.openModal('modal-settings');
  },

  // ============================================================
  // EVENT LISTENERS
  // ============================================================

  setupEventListeners() {
    // ── Message input ─────────────────────────────────────
    const input   = document.getElementById('msg-input');
    const sendBtn = document.getElementById('btn-send');

    const handleSend = () => {
      const text = input?.value?.trim();
      if (!text) return;
      this.sendMessage(text);
      input.value = '';
    };

    sendBtn?.addEventListener('click', handleSend);
    input?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });

    // Typing indicator
    input?.addEventListener('input', () => this.handleTyping());

    // ── File upload ───────────────────────────────────────
    document.getElementById('btn-attach')?.addEventListener('click', () => {
      document.getElementById('file-input')?.click();
    });
    document.getElementById('file-input')?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (file) await this.sendFile(file);
      e.target.value = '';
    });

    // Emoji picker (simple)
    document.getElementById('btn-emoji')?.addEventListener('click', () => {
      UI.showToast('اختر إيموجي من لوحة مفاتيحك 😊', 'info');
    });

    // ── Search ────────────────────────────────────────────
    document.getElementById('sidebar-search')?.addEventListener('input', e => {
      this.searchConversations(e.target.value);
    });

    // ── New chat button ───────────────────────────────────
    document.getElementById('btn-new-chat')?.addEventListener('click', () => {
      UI.openModal('modal-new-chat');
      document.getElementById('user-search-input')?.focus();
    });

    // User search in modal
    let searchTimeout;
    document.getElementById('user-search-input')?.addEventListener('input', e => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => this.handleUserSearch(e.target.value), 350);
    });

    // ── Create group ──────────────────────────────────────
    document.getElementById('btn-create-group')?.addEventListener('click', () => {
      UI.openModal('modal-create-group');
    });

    document.getElementById('form-create-group')?.addEventListener('submit', async e => {
      e.preventDefault();
      const name = document.getElementById('group-name')?.value;
      const desc = document.getElementById('group-desc')?.value;
      const selectedUsers = [...document.querySelectorAll('.group-member-check:checked')].map(el => el.value);
      UI.setLoading('btn-submit-group', true);
      await this.createGroup(name, desc, selectedUsers);
      UI.setLoading('btn-submit-group', false);
      UI.closeModal('modal-create-group');
      document.getElementById('form-create-group')?.reset();
    });

    // ── Notifications ─────────────────────────────────────
    document.getElementById('btn-notifications')?.addEventListener('click', () => {
      UI.openModal('modal-notifications');
    });

    document.getElementById('btn-mark-all-read')?.addEventListener('click', () => {
      this.markAllNotificationsRead();
    });

    // ── Settings / Profile ────────────────────────────────
    document.getElementById('btn-signout')?.addEventListener('click', () => {
      if (confirm('هل تريد تسجيل الخروج؟')) Auth.signOut();
    });

    document.getElementById('form-settings')?.addEventListener('submit', async e => {
      e.preventDefault();
      UI.setLoading('btn-save-settings', true);
      const updates = {
        full_name: document.getElementById('settings-name')?.value?.trim(),
        username:  document.getElementById('settings-username')?.value?.trim().toLowerCase(),
        bio:       document.getElementById('settings-bio')?.value?.trim()
      };
      const { error } = await Auth.updateProfile(updates);
      UI.setLoading('btn-save-settings', false);
      if (error) { UI.showToast('فشل تحديث الملف الشخصي: ' + error.message, 'error'); return; }
      UI.showToast('تم تحديث ملفك الشخصي', 'success');
      this.renderUserMini();
      UI.closeModal('modal-settings');
    });

    // Avatar upload in settings
    document.getElementById('avatar-upload-btn')?.addEventListener('click', () => {
      document.getElementById('avatar-file-input')?.click();
    });

    document.getElementById('avatar-file-input')?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      UI.showToast('جاري رفع الصورة...', 'info');
      const { url, error } = await Auth.uploadAvatar(file);
      if (error) { UI.showToast('فشل رفع الصورة', 'error'); return; }
      await Auth.updateProfile({ avatar_url: url });
      this.renderUserMini();
      UI.showToast('تم تحديث صورتك الشخصية', 'success');
      e.target.value = '';
    });

    // ── Modal close buttons ───────────────────────────────
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => UI.closeModal(btn.dataset.closeModal));
    });

    // Close modal on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', e => {
        if (e.target === modal) UI.closeModal(modal.id);
      });
    });

    // ── Nav tabs ──────────────────────────────────────────
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.filterConversations(tab.dataset.tab);
      });
    });

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // ── Status selector ───────────────────────────────────
    document.querySelectorAll('[data-status]').forEach(btn => {
      btn.addEventListener('click', () => {
        const status = btn.dataset.status;
        this.updatePresence(status);
        UI.showToast(`حالتك الآن: ${btn.textContent}`, 'success');
      });
    });

    // Subscribe to incoming calls
    this.subscribeToIncomingCalls();
  },

  filterConversations(tab) {
    const filtered = tab === 'all' ? AppState.rooms
      : tab === 'groups' ? AppState.rooms.filter(r => r.room.type === 'group')
      : tab === 'direct' ? AppState.rooms.filter(r => r.room.type === 'direct')
      : AppState.rooms;

    const container = document.getElementById('conversations-list');
    if (!container) return;
    container.innerHTML = filtered.map(rd => this.renderConversationItem(rd)).join('');
  },

  async handleUserSearch(query) {
    const resultsEl = document.getElementById('user-search-results');
    if (!resultsEl) return;
    if (!query?.trim() || query.length < 2) {
      resultsEl.innerHTML = '';
      return;
    }
    resultsEl.innerHTML = '<div style="padding:12px;text-align:center"><span class="spinner"></span></div>';
    const users = await this.searchUsers(query);
    if (!users.length) {
      resultsEl.innerHTML = '<div style="padding:12px;color:var(--muted);text-align:center">لا نتائج</div>';
      return;
    }
    resultsEl.innerHTML = users.map(u => `
      <div class="search-result-item" onclick="App.createDirectMessage('${u.id}')">
        ${UI.avatarHtml(u, 40)}
        <div style="flex:1">
          <div style="font-weight:600">${UI.escapeHtml(u.full_name || u.username)}</div>
          <div style="font-size:.82rem;color:var(--muted)">@${UI.escapeHtml(u.username)}</div>
        </div>
        <span class="presence-dot status-${u.status || 'offline'}"></span>
      </div>`).join('');
  },

  handleTyping() {
    if (!AppState.currentRoomId) return;
    clearTimeout(AppState.typingTimers[AppState.currentRoomId]);
    // Could broadcast typing event via Supabase Realtime channel
    AppState.typingTimers[AppState.currentRoomId] = setTimeout(() => {
      // stopped typing
    }, 2000);
  }
};

// ── Start app ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
