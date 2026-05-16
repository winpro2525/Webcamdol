// ============================================================
// EpicTalk - Authentication Module
// ============================================================

const Auth = {

  // ── Sign Up ──────────────────────────────────────────────
  async signUp(email, password, username, fullName) {
    try {
      const { data, error } = await db.auth.signUp({
        email,
        password,
        options: {
          data: {
            username:  username || email.split('@')[0],
            full_name: fullName || username || email.split('@')[0]
          }
        }
      });
      if (error) throw error;
      return { data, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  },

  // ── Sign In ──────────────────────────────────────────────
  async signIn(email, password) {
    try {
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return { data, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  },

  // ── Google OAuth ─────────────────────────────────────────
  async signInWithGoogle() {
    try {
      const { data, error } = await db.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin +
            (window.location.pathname.includes('index') || window.location.pathname === '/'
              ? '/app.html' : '/app.html')
        }
      });
      if (error) throw error;
      return { data, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  },

  // ── Sign Out ─────────────────────────────────────────────
  async signOut() {
    try {
      if (AppState.user) {
        await db.from('profiles')
          .update({ status: 'offline', last_seen: new Date().toISOString() })
          .eq('id', AppState.user.id);
      }
      // Clean up realtime channels
      Object.values(AppState.channels).forEach(ch => db.removeChannel(ch));
      AppState.channels = {};

      await db.auth.signOut();
      window.location.href = 'index.html';
    } catch (err) {
      console.error('Sign out error:', err);
      window.location.href = 'index.html';
    }
  },

  // ── Get current user ─────────────────────────────────────
  async getUser() {
    const { data: { user } } = await db.auth.getUser();
    return user;
  },

  // ── Get profile ──────────────────────────────────────────
  async getProfile(userId) {
    const { data, error } = await db
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    return { data, error };
  },

  // ── Update profile ───────────────────────────────────────
  async updateProfile(updates) {
    if (!AppState.user) return { data: null, error: new Error('Not authenticated') };
    const { data, error } = await db
      .from('profiles')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', AppState.user.id)
      .select()
      .single();
    if (!error && data) AppState.profile = data;
    return { data, error };
  },

  // ── Upload avatar ────────────────────────────────────────
  async uploadAvatar(file) {
    if (!AppState.user) return { url: null, error: new Error('Not authenticated') };

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      return { url: null, error: new Error('حجم الصورة يجب أن يكون أقل من 5MB') };
    }

    const allowed = ['image/jpeg','image/png','image/webp','image/gif'];
    if (!allowed.includes(file.type)) {
      return { url: null, error: new Error('نوع الملف غير مدعوم. استخدم JPG أو PNG أو WebP') };
    }

    const ext      = file.name.split('.').pop().toLowerCase();
    const fileName = `${AppState.user.id}/avatar.${ext}`;

    const { error: uploadErr } = await db.storage
      .from('avatars')
      .upload(fileName, file, { upsert: true, contentType: file.type });

    if (uploadErr) return { url: null, error: uploadErr };

    const { data: { publicUrl } } = db.storage.from('avatars').getPublicUrl(fileName);
    return { url: publicUrl + `?t=${Date.now()}`, error: null };
  },

  // ── Reset password ───────────────────────────────────────
  async resetPassword(email) {
    const { error } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/index.html'
    });
    return { error };
  },

  // ── Update password ──────────────────────────────────────
  async updatePassword(newPassword) {
    const { error } = await db.auth.updateUser({ password: newPassword });
    return { error };
  },

  // ── Auth state listener ──────────────────────────────────
  onAuthStateChange(callback) {
    return db.auth.onAuthStateChange(callback);
  },

  // ── Validate email ───────────────────────────────────────
  isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  },

  // ── Validate password ────────────────────────────────────
  isValidPassword(password) {
    return password && password.length >= 6;
  },

  // ── Translate auth errors to Arabic ──────────────────────
  getErrorMessage(error) {
    const msg = (error?.message || '').toLowerCase();
    if (msg.includes('invalid login credentials'))    return 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
    if (msg.includes('email not confirmed'))          return 'يرجى تأكيد بريدك الإلكتروني أولاً';
    if (msg.includes('user already registered'))      return 'هذا البريد الإلكتروني مسجل مسبقاً';
    if (msg.includes('password should be at least')) return 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
    if (msg.includes('rate limit'))                   return 'محاولات كثيرة. حاول بعد قليل';
    if (msg.includes('network'))                      return 'خطأ في الاتصال بالشبكة';
    return error?.message || 'حدث خطأ غير متوقع';
  }
};

// ============================================================
// AUTH PAGE LOGIC  (only runs on index.html)
// ============================================================
if (document.getElementById('auth-form-login')) {
  document.addEventListener('DOMContentLoaded', () => {

    // Check if user is already logged in → redirect to app
    db.auth.getSession().then(({ data: { session } }) => {
      if (session) window.location.href = 'app.html';
    });

    const loginForm    = document.getElementById('auth-form-login');
    const registerForm = document.getElementById('auth-form-register');
    const tabLogin     = document.getElementById('tab-login');
    const tabRegister  = document.getElementById('tab-register');

    // Toggle between login / register
    function showTab(tab) {
      if (tab === 'login') {
        loginForm.style.display = 'flex';
        registerForm.style.display = 'none';
        tabLogin.classList.add('active');
        tabRegister.classList.remove('active');
      } else {
        loginForm.style.display = 'none';
        registerForm.style.display = 'flex';
        tabRegister.classList.add('active');
        tabLogin.classList.remove('active');
      }
    }

    tabLogin?.addEventListener('click',    () => showTab('login'));
    tabRegister?.addEventListener('click', () => showTab('register'));

    // Forgot password link
    document.getElementById('forgot-password-link')?.addEventListener('click', async e => {
      e.preventDefault();
      const email = document.getElementById('login-email')?.value?.trim();
      if (!email) { UI.showToast('أدخل بريدك الإلكتروني أولاً', 'warning'); return; }
      if (!Auth.isValidEmail(email)) { UI.showToast('البريد الإلكتروني غير صحيح', 'error'); return; }
      const { error } = await Auth.resetPassword(email);
      if (error) { UI.showToast(Auth.getErrorMessage(error), 'error'); return; }
      UI.showToast('تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك', 'success', 5000);
    });

    // Password visibility toggle
    document.querySelectorAll('.toggle-password').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = btn.previousElementSibling;
        if (!input) return;
        const isText = input.type === 'text';
        input.type = isText ? 'password' : 'text';
        btn.textContent = isText ? '👁' : '🙈';
      });
    });

    // ── LOGIN SUBMIT ────────────────────────────────────────
    loginForm?.addEventListener('submit', async e => {
      e.preventDefault();
      const email    = document.getElementById('login-email')?.value?.trim();
      const password = document.getElementById('login-password')?.value;
      const errorEl  = document.getElementById('login-error');

      if (!Auth.isValidEmail(email)) {
        errorEl.textContent = 'البريد الإلكتروني غير صحيح';
        errorEl.style.display = 'block'; return;
      }
      if (!Auth.isValidPassword(password)) {
        errorEl.textContent = 'كلمة المرور قصيرة جداً';
        errorEl.style.display = 'block'; return;
      }
      errorEl.style.display = 'none';
      UI.setLoading('btn-login', true);

      const { error } = await Auth.signIn(email, password);
      UI.setLoading('btn-login', false);

      if (error) {
        errorEl.textContent = Auth.getErrorMessage(error);
        errorEl.style.display = 'block';
        return;
      }
      window.location.href = 'app.html';
    });

    // ── REGISTER SUBMIT ─────────────────────────────────────
    registerForm?.addEventListener('submit', async e => {
      e.preventDefault();
      const fullName  = document.getElementById('reg-name')?.value?.trim();
      const username  = document.getElementById('reg-username')?.value?.trim().toLowerCase();
      const email     = document.getElementById('reg-email')?.value?.trim();
      const password  = document.getElementById('reg-password')?.value;
      const password2 = document.getElementById('reg-password2')?.value;
      const errorEl   = document.getElementById('register-error');

      if (!fullName)                       { errorEl.textContent = 'أدخل اسمك الكامل'; errorEl.style.display='block'; return; }
      if (!username || username.length < 3){ errorEl.textContent = 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل'; errorEl.style.display='block'; return; }
      if (!/^[a-z0-9_]+$/.test(username)) { errorEl.textContent = 'اسم المستخدم: أحرف إنجليزية وأرقام وشرطة سفلية فقط'; errorEl.style.display='block'; return; }
      if (!Auth.isValidEmail(email))       { errorEl.textContent = 'البريد الإلكتروني غير صحيح'; errorEl.style.display='block'; return; }
      if (!Auth.isValidPassword(password)) { errorEl.textContent = 'كلمة المرور يجب أن تكون 6 أحرف على الأقل'; errorEl.style.display='block'; return; }
      if (password !== password2)          { errorEl.textContent = 'كلمتا المرور غير متطابقتين'; errorEl.style.display='block'; return; }
      errorEl.style.display = 'none';
      UI.setLoading('btn-register', true);

      const { error } = await Auth.signUp(email, password, username, fullName);
      UI.setLoading('btn-register', false);

      if (error) {
        errorEl.textContent = Auth.getErrorMessage(error);
        errorEl.style.display = 'block';
        return;
      }
      UI.showToast('تم إنشاء حسابك! تحقق من بريدك الإلكتروني للتأكيد', 'success', 6000);
      showTab('login');
    });

    // ── GOOGLE AUTH ─────────────────────────────────────────
    document.querySelectorAll('.btn-google').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { error } = await Auth.signInWithGoogle();
        if (error) UI.showToast(Auth.getErrorMessage(error), 'error');
      });
    });
  });
}
