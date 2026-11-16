
/* =========================================
   SHUNEL — PROFILES
   Gestión de perfiles y datos de usuario
========================================= */

(() => {
  "use strict";

  const STORAGE_KEY = "shunel_profile";
  const DEFAULT_AVATAR = "";

  const state = {
    profile: null,
    user: null,
    loading: false,
    initialized: false
  };

  function getSupabase() {
    return (
      window.shunelSupabase ||
      window.supabaseClient ||
      window._supabase ||
      null
    );
  }

  function getDefaultProfile() {
    return {
      id: null,
      username: "",
      display_name: "",
      avatar_url: DEFAULT_AVATAR,
      bio: "",
      is_private: false,
      is_public: true,
      created_at: null
    };
  }

  function normalizeUsername(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.]/g, "")
      .slice(0, 24);
  }

  function cleanText(value, maxLength = 120) {
    return String(value || "")
      .trim()
      .slice(0, maxLength);
  }

  function validateProfile(data) {
    const errors = [];

    const username = normalizeUsername(data.username);
    const displayName = cleanText(data.display_name, 40);
    const bio = cleanText(data.bio, 160);
    const avatarUrl = cleanText(data.avatar_url, 1000);

    if (!username) {
      errors.push("El nombre de usuario es obligatorio.");
    } else if (username.length < 3) {
      errors.push("El nombre de usuario debe tener al menos 3 caracteres.");
    }

    if (!displayName) {
      errors.push("El nombre del perfil es obligatorio.");
    }

    if (
      avatarUrl &&
      !/^https:\/\//i.test(avatarUrl)
    ) {
      errors.push("La imagen debe utilizar una dirección HTTPS.");
    }

    return {
      valid: errors.length === 0,
      errors,
      data: {
        username,
        display_name: displayName,
        avatar_url: avatarUrl,
        bio,
        is_private: Boolean(data.is_private),
        is_public: !Boolean(data.is_private)
      }
    };
  }

  function saveLocal(profile) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(profile)
      );

      state.profile = profile;

      document.dispatchEvent(
        new CustomEvent("shunel:profile-updated", {
          detail: { profile }
        })
      );

      return true;
    } catch (error) {
      console.error("[Shunel Profiles] Error local:", error);
      return false;
    }
  }

  function loadLocal() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "null"
      );

      if (saved && typeof saved === "object") {
        state.profile = {
          ...getDefaultProfile(),
          ...saved
        };
      } else {
        state.profile = getDefaultProfile();
      }
    } catch {
      state.profile = getDefaultProfile();
    }

    return state.profile;
  }

  async function getAuthenticatedUser() {
    const client = getSupabase();

    if (!client?.auth) return null;

    const { data, error } = await client.auth.getUser();

    if (error) {
      console.warn("[Shunel Profiles] No se pudo verificar la sesión:", error);
      return null;
    }

    state.user = data?.user || null;

    return state.user;
  }

  async function fetchProfile(userId) {
    const client = getSupabase();

    if (!client || !userId) return null;

    const { data, error } = await client
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      console.error("[Shunel Profiles] Error leyendo perfil:", error);
      throw error;
    }

    return data;
  }

  async function createProfile(user, profileData = {}) {
    const client = getSupabase();

    if (!client || !user?.id) {
      throw new Error("No hay una sesión válida de Supabase.");
    }

    const initial = {
      ...getDefaultProfile(),
      ...profileData
    };

    const emailName = user.email
      ? user.email.split("@")[0]
      : "";

    const username = normalizeUsername(
      initial.username || emailName
    );

    const displayName = cleanText(
      initial.display_name || username,
      40
    );

    if (username.length < 3) {
      throw new Error("Elegí un nombre de usuario de al menos 3 caracteres.");
    }

    const payload = {
      id: user.id,
      username,
      display_name: displayName,
      avatar_url: cleanText(initial.avatar_url, 1000),
      bio: cleanText(initial.bio, 160),
      is_private: Boolean(initial.is_private),
      is_public: !Boolean(initial.is_private)
    };

    const { data, error } = await client
      .from("profiles")
      .insert(payload)
      .select()
      .single();

    if (error) {
      console.error("[Shunel Profiles] Error creando perfil:", error);
      throw error;
    }

    saveLocal(data);

    return data;
  }

  async function loadProfile() {
    state.loading = true;

    try {
      loadLocal();

      const user = await getAuthenticatedUser();

      if (!user) {
        return state.profile;
      }

      const remoteProfile = await fetchProfile(user.id);

      if (remoteProfile) {
        saveLocal(remoteProfile);
        return remoteProfile;
      }

      // Si todavía no existe un perfil remoto,
      // se conserva el perfil local hasta crearlo.
      return state.profile;

    } finally {
      state.loading = false;
    }
  }

  async function create(data = {}) {
    const validation = validateProfile({
      ...state.profile,
      ...data
    });

    if (!validation.valid) {
      throw new Error(validation.errors.join(" "));
    }

    const user = await getAuthenticatedUser();

    if (!user) {
      const localProfile = {
        ...getDefaultProfile(),
        ...validation.data
      };

      saveLocal(localProfile);

      return localProfile;
    }

    return createProfile(user, validation.data);
  }

  async function update(data = {}) {
    const current = state.profile || loadLocal();

    const validation = validateProfile({
      ...current,
      ...data
    });

    if (!validation.valid) {
      throw new Error(validation.errors.join(" "));
    }

    const user = await getAuthenticatedUser();

    if (!user) {
      const updated = {
        ...current,
        ...validation.data
      };

      saveLocal(updated);

      return updated;
    }

    const client = getSupabase();

    const { data: updated, error } = await client
      .from("profiles")
      .update(validation.data)
      .eq("id", user.id)
      .select()
      .single();

    if (error) {
      console.error("[Shunel Profiles] Error actualizando:", error);
      throw error;
    }

    saveLocal(updated);

    return updated;
  }

  async function uploadAvatar(file) {
    const client = getSupabase();
    const user = await getAuthenticatedUser();

    if (!client || !user) {
      throw new Error("Iniciá sesión para subir una foto.");
    }

    if (!(file instanceof File)) {
      throw new Error("Seleccioná una imagen válida.");
    }

    if (!file.type.startsWith("image/")) {
      throw new Error("El archivo debe ser una imagen.");
    }

    if (file.size > 5 * 1024 * 1024) {
      throw new Error("La imagen no puede superar los 5 MB.");
    }

    const extension = file.name.split(".").pop()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "jpg";

    const path = `${user.id}/avatar-${Date.now()}.${extension}`;

    const { error: uploadError } = await client
      .storage
      .from("avatars")
      .upload(path, file, {
        upsert: true,
        contentType: file.type
      });

    if (uploadError) {
      console.error("[Shunel Profiles] Error subiendo avatar:", uploadError);
      throw uploadError;
    }

    const { data } = client
      .storage
      .from("avatars")
      .getPublicUrl(path);

    const avatarUrl = data?.publicUrl;

    if (!avatarUrl) {
      throw new Error("No se pudo obtener la dirección de la imagen.");
    }

    return update({
      ...state.profile,
      avatar_url: avatarUrl
    });
  }

  async function findByUsername(username) {
    const client = getSupabase();
    const normalized = normalizeUsername(username);

    if (!client || !normalized) return null;

    const { data, error } = await client
      .from("profiles")
      .select("id, username, display_name, avatar_url, bio, is_private, is_public")
      .eq("username", normalized)
      .maybeSingle();

    if (error) {
      console.error("[Shunel Profiles] Error buscando usuario:", error);
      throw error;
    }

    return data;
  }

  async function getPublicProfile(userId) {
    const client = getSupabase();

    if (!client || !userId) return null;

    const { data, error } = await client
      .from("profiles")
      .select("id, username, display_name, avatar_url, bio, is_private, is_public")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw error;

    return data;
  }

  function getProfile() {
    return state.profile || loadLocal();
  }

  function getUser() {
    return state.user;
  }

  function clearLocal() {
    localStorage.removeItem(STORAGE_KEY);
    state.profile = getDefaultProfile();
    state.user = null;

    document.dispatchEvent(
      new CustomEvent("shunel:profile-cleared")
    );
  }

  async function initialize() {
    if (state.initialized) return;

    state.initialized = true;

    loadLocal();

    window.ShunelProfiles = {
      load: loadProfile,
      create,
      update,
      uploadAvatar,
      findByUsername,
      getPublicProfile,
      getProfile,
      getUser,
      clearLocal,
      validate: validateProfile
    };

    try {
      await loadProfile();
    } catch (error) {
      console.warn("[Shunel Profiles] Se utilizará el perfil local:", error);
    }

    document.dispatchEvent(
      new CustomEvent("shunel:profiles-ready", {
        detail: {
          profile: state.profile,
          user: state.user
        }
      })
    );

    console.info("[Shunel Profiles] Módulo preparado.");
  }

  initialize();

})();
