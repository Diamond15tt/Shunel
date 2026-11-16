
/* =========================================
   SHUNEL — USER PROFILES
   Perfiles y sincronización con Supabase
   Version: 2.0.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelProfiles) return;

  const CONFIG = {
    storageKey: "shunel_profile",
    table: "profiles",
    timeout: 15000
  };

  const state = {
    initialized: false,
    loading: false,
    saving: false,
    user: null,
    profile: null,
    client: null,
    requestId: 0
  };

  function emit(name, detail = {}) {
    if (window.ShunelEvents) {
      window.ShunelEvents.emit(name, detail);
    } else {
      window.dispatchEvent(
        new CustomEvent(`shunel:${name}`, { detail })
      );
    }
  }

  function getSupabase() {
    return (
      window.shunelSupabase ||
      window.supabaseClient ||
      window._supabase ||
      null
    );
  }

  function normalizeProfile(data = {}) {
    return {
      id: data.id || null,
      username: String(data.username || "").trim(),
      display_name: String(
        data.display_name || data.username || ""
      ).trim(),
      bio: String(data.bio || ""),
      avatar_url: data.avatar_url || null,
      created_at: data.created_at || null,
      updated_at: data.updated_at || null
    };
  }

  function readLocal() {
    try {
      const saved = localStorage.getItem(CONFIG.storageKey);

      return saved
        ? normalizeProfile(JSON.parse(saved))
        : null;
    } catch (error) {
      console.warn(
        "[Shunel Profiles] Caché local inválida.",
        error
      );

      return null;
    }
  }

  function saveLocal(profile) {
    try {
      localStorage.setItem(
        CONFIG.storageKey,
        JSON.stringify(profile)
      );

      return true;
    } catch (error) {
      console.warn(
        "[Shunel Profiles] Error guardando caché:",
        error
      );

      return false;
    }
  }

  async function getAuthenticatedUser() {
    const client = state.client || getSupabase();

    if (!client?.auth) return null;

    const { data, error } = await client.auth.getUser();

    if (error) throw error;

    return data?.user || null;
  }

  async function loadFromServer(userId) {
    const client = state.client || getSupabase();

    if (!client || !userId) return null;

    const { data, error } = await client
      .from(CONFIG.table)
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw error;

    return data ? normalizeProfile(data) : null;
  }

  async function createProfile(user) {
    const client = state.client || getSupabase();

    if (!client || !user?.id) {
      throw new Error("No hay un usuario autenticado.");
    }

    const metadata = user.user_metadata || {};

    const profile = normalizeProfile({
      id: user.id,
      username:
        metadata.username ||
        user.email?.split("@")[0] ||
        "usuario",
      display_name:
        metadata.display_name ||
        metadata.full_name ||
        metadata.username ||
        "Usuario",
      bio: "",
      avatar_url: metadata.avatar_url || null
    });

    const { data, error } = await client
      .from(CONFIG.table)
      .upsert(profile, {
        onConflict: "id"
      })
      .select()
      .single();

    if (error) throw error;

    return normalizeProfile(data);
  }

  async function load() {
    if (state.loading) return state.profile;

    state.loading = true;

    const requestId = ++state.requestId;

    emit("profile:loading", {
      loading: true
    });

    try {
      state.client = getSupabase();

      if (!state.client) {
        state.profile = readLocal();

        emit("profile:offline", {
          profile: state.profile
        });

        return state.profile;
      }

      const user = await getAuthenticatedUser();

      if (requestId !== state.requestId) return null;

      if (!user) {
        state.user = null;
        state.profile = null;

        emit("profile:logged-out", {});

        return null;
      }

      state.user = user;

      let profile = await loadFromServer(user.id);

      if (requestId !== state.requestId) return null;

      if (!profile) {
        profile = await createProfile(user);
      }

      if (requestId !== state.requestId) return null;

      state.profile = profile;

      saveLocal(profile);

      emit("profile:loaded", {
        profile
      });

      return profile;

    } catch (error) {
      console.error(
        "[Shunel Profiles] Error cargando perfil:",
        error
      );

      state.profile = readLocal();

      emit("profile:error", {
        message: error.message,
        profile: state.profile
      });

      return state.profile;

    } finally {
      if (requestId === state.requestId) {
        state.loading = false;

        emit("profile:loading", {
          loading: false
        });
      }
    }
  }

  async function update(changes = {}) {
    if (!state.user?.id) {
      throw new Error("Debes iniciar sesión para editar tu perfil.");
    }

    if (state.saving) {
      throw new Error("Ya hay una actualización en curso.");
    }

    const allowedFields = [
      "username",
      "display_name",
      "bio",
      "avatar_url"
    ];

    const updates = {};

    allowedFields.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(changes, field)) {
        updates[field] = changes[field];
      }
    });

    if (!Object.keys(updates).length) {
      return state.profile;
    }

    if (
      updates.username !== undefined &&
      !/^[a-zA-Z0-9_.-]{3,24}$/.test(updates.username)
    ) {
      throw new Error(
        "El nombre de usuario debe tener entre 3 y 24 caracteres."
      );
    }

    if (
      updates.bio !== undefined &&
      String(updates.bio).length > 300
    ) {
      throw new Error(
        "La biografía no puede superar los 300 caracteres."
      );
    }

    if (
      updates.display_name !== undefined &&
      String(updates.display_name).length > 50
    ) {
      throw new Error(
        "El nombre no puede superar los 50 caracteres."
      );
    }

    if (
      updates.avatar_url !== undefined &&
      updates.avatar_url !== null
    ) {
      try {
        const url = new URL(updates.avatar_url);

        if (!["https:", "http:"].includes(url.protocol)) {
          throw new Error();
        }
      } catch {
        throw new Error("La dirección de la fotografía no es válida.");
      }
    }

    state.saving = true;

    emit("profile:saving", {
      saving: true
    });

    try {
      const client = state.client || getSupabase();

      if (!client) {
        throw new Error("No hay conexión con Supabase.");
      }

      const payload = {
        ...updates,
        updated_at: new Date().toISOString()
      };

      const { data, error } = await client
        .from(CONFIG.table)
        .update(payload)
        .eq("id", state.user.id)
        .select()
        .single();

      if (error) throw error;

      state.profile = normalizeProfile(data);

      saveLocal(state.profile);

      emit("profile:updated", {
        profile: state.profile
      });

      return state.profile;

    } catch (error) {
      emit("profile:error", {
        message: error.message
      });

      throw error;

    } finally {
      state.saving = false;

      emit("profile:saving", {
        saving: false
      });
    }
  }

  function getProfile() {
    return state.profile
      ? { ...state.profile }
      : null;
  }

  function setClient(client) {
    if (!client?.auth || typeof client.from !== "function") {
      return false;
    }

    state.client = client;

    return true;
  }

  function clearLocal() {
    try {
      localStorage.removeItem(CONFIG.storageKey);
    } catch {}

    state.profile = null;
    state.user = null;

    emit("profile:cleared", {});

    return true;
  }

  function initialize() {
    if (state.initialized) return;

    state.client = getSupabase();
    state.profile = readLocal();

    state.initialized = true;

    emit("profile:ready", {
      cached: Boolean(state.profile)
    });

    console.info("[Shunel Profiles] Sistema preparado.");
  }

  window.ShunelProfiles = Object.freeze({
    initialize,
    load,
    update,
    getProfile,
    setClient,
    clearLocal,

    getState() {
      return {
        initialized: state.initialized,
        loading: state.loading,
        saving: state.saving,
        authenticated: Boolean(state.user),
        profile: getProfile()
      };
    }
  });

  initialize();

})();
