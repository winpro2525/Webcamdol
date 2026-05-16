// ============================================================
// EpicTalk - Supabase Configuration & Global State
// ============================================================
// 🔧 Replace with your actual Supabase project credentials
// 📍 Find them: https://app.supabase.com → Project Settings → API
// ============================================================

const SUPABASE_URL    = https://gqwlqzmfdllhciblctwz.supabase.co/rest/v1/;      // e.g. https://abcxyz.supabase.co
const SUPABASE_ANON_KEY = 







eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdxd2xxem1mZGxsaGNpYmxjdHd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5MjUwNDksImV4cCI6MjA5NDUwMTA0OX0.bVWjyu37TqLuJLx938M3aAUvQnvxcPB6UXOx__3q0PQ; // starts with eyJ...

// Create Supabase client
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken:  true,
    persistSession:    true,
    detectSessionInUrl: true
  },
  realtime: {
    params: { eventsPerSecond: 10 }
  }
});

// ============================================================
// GLOBAL APP STATE
// ============================================================
const AppState = {
  user:          null,   // Current auth.users record
  profile:       null,   // Current profiles record
  currentRoomId: null,   // Active chat room ID
  rooms:         [],     // All user rooms [{room, lastMessage, unread}]
  messages:      {},     // Messages keyed by room_id: []
  notifications: [],     // Notification records
  unreadCounts:  {},     // { roomId: number }
  onlineUsers:   new Set(),
  channels:      {},     // Active Supabase realtime channels
  typingTimers:  {},     // Debounce timers for typing indicator
  call: {
    id:          null,
    roomId:      null,
    type:        'video',   // 'video' | 'audio'
    status:      null,      // 'ringing' | 'active' | 'ended'
    initiatedBy: null,
    isInitiator: false
  }
};

// ============================================================
// UI HELPERS
// ============================================================
const UI = {

  // ── Toast notifications ───────────────────────────────────
  showToast(message, type = 'info', duration = 3500) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    const palettes = {
      info:    { border: '#7c5cff', icon: 'ℹ️' },
      success: { border: '#30d28c', icon: '✅' },
      error:   { border: '#ff5c70', icon: '❌' },
      warning: { border: '#ffca5c', icon: '⚠️' }
    };
    const p = palettes[type] || palettes.info;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.borderLeftColor = p.border;
    toast.innerHTML = `<span class="toast-icon">${p.icon}</span><span>${this.escapeHtml(message)}</span>`;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 350);
    }, duration);
  },

  // ── Modal helpers ─────────────────────────────────────────
  openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.style.display = 'flex';
    requestAnimationFrame(() => m.classList.add('open'));
  },

  closeModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.remove('open');
    setTimeout(() => { m.style.display = 'none'; }, 280);
  },

  closeAllModals() {
    document.querySelectorAll('.modal.open').forEach(m => {
      m.classList.remove('open');
      setTimeout(() => { m.style.display = 'none'; }, 280);
    });
  },

  // ── Loading state ─────────────────────────────────────────
  setLoading(btnId, isLoading, originalText = '') {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (isLoading) {
      btn.dataset.originalText = btn.textContent;
      btn.innerHTML = '<span class="spinner"></span>';
      btn.disabled  = true;
    } else {
      btn.textContent = btn.dataset.originalText || originalText;
      btn.disabled    = false;
    }
  },

  // ── Time formatting ───────────────────────────────────────
  formatTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now  = new Date();
    const diff = now - date;

    if (diff < 60000)       return 'الآن';
    if (diff < 3600000)     return `${Math.floor(diff/60000)} د`;
    if (diff < 86400000)    return date.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
    if (diff < 604800000)   return date.toLocaleDateString('ar', { weekday: 'short' });
    return date.toLocaleDateString('ar', { month: 'short', day: 'numeric' });
  },

  formatFullTime(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString('ar', {
      hour: '2-digit', minute: '2-digit', hour12: true
    });
  },

  formatDuration(seconds) {
    if (!seconds) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2,'0')}`;
  },

  // ── Utility ───────────────────────────────────────────────
  getInitials(name) {
    if (!name) return '؟';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) return parts[0][0] + parts[1][0];
    return parts[0][0] || '؟';
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
  },

  linkify(text) {
    const escaped = this.escapeHtml(text);
    const urlRe = /https?:\/\/[^\s<>"]+/g;
    return escaped.replace(urlRe, url =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
    );
  },

  // ── Scroll helpers ─────────────────────────────────────────
  scrollToBottom(containerId, smooth = true) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  },

  isScrolledToBottom(containerId, threshold = 120) {
    const el = document.getElementById(containerId);
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  },

  // ── Avatar generator ───────────────────────────────────────
  avatarHtml(profile, size = 44, extraClass = '') {
    if (profile?.avatar_url) {
      return `<img src="${profile.avatar_url}" class="avatar ${extraClass}"
                   style="width:${size}px;height:${size}px;border-radius:14px;object-fit:cover;"
                   onerror="this.parentElement.innerHTML=UI.initialsAvatar('${UI.escapeHtml(profile.full_name||profile.username||'؟')}', ${size}, '${extraClass}')">`;
    }
    return this.initialsAvatar(profile?.full_name || profile?.username || '؟', size, extraClass);
  },

  initialsAvatar(name, size = 44, extraClass = '') {
    const initials = this.getInitials(name);
    const colors = ['#7c5cff','#24d3ee','#ff4fd8','#30d28c','#ff5c70','#ffca5c','#ff8a5c'];
    const color  = colors[(name.charCodeAt(0) || 0) % colors.length];
    return `<div class="avatar ${extraClass}"
               style="width:${size}px;height:${size}px;border-radius:14px;
                      background:${color};display:grid;place-items:center;
                      font-weight:800;font-size:${Math.floor(size*0.38)}px;color:#fff;flex:0 0 auto;">
              ${initials}
            </div>`;
  }
};

