
/* =========================================
   SHUNEL — SOCIAL ENGINE
   Seguidores, perfiles y comunidad
========================================= */

(() => {
  "use strict";

  const state = {
    user: null,
    following: [],
    followers: [],
    initialized: false,
    loading: false
  };

  function getSupabase() {
    return (
      window.shunelSupabase ||
      window.supabaseClient ||
      window._supabase ||
      null
    );
  }

  function getClient() {
    const client = getSupabase();

    if (!client) {
      throw new Error("Supabase no está conectado.");
    }

    return client;
  }

  async function getUser() {
    const client = getClient();

    const { data, error } = await client.auth.getUser();

    if (error) throw error;

    state.user = data?.user || null;

    if (!state.user) {
      throw new Error("Iniciá sesión para utilizar las funciones sociales.");
    }

    return state.user;
  }

  function normalizeUsername(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.]/g, "")
      .slice(0, 24);
  }

  function dispatch(name, detail = {}) {
    document.dispatchEvent(
      new CustomEvent(name, { detail })
    );
  }

  function normalizeProfile(profile) {
    if (!profile) return null;

    return {
      id: profile.id,
      username: profile.username || "",
      display_name: profile.display_name || profile.username || "Usuario",
      avatar_url: profile.avatar_url || "",
      bio: profile.bio || "",
      is_private: Boolean(profile.is_private),
      is_public: profile.is_public !== false
    };
  }

  /* =========================================
     BUSCAR USUARIOS
  ========================================= */

  async function searchUsers(query, limit = 20) {
    const client = getClient();
    const search = normalizeUsername(query);

    if (search.length < 2) return [];

    const { data, error } = await client
      .from("profiles")
      .select(
        "id, username, display_name, avatar_url, bio, is_private, is_public"
      )
      .ilike("username", `%${search}%`)
      .eq("is_public", true)
      .limit(Math.min(50, Math.max(1, limit)));

    if (error) {
      console.error("[Shunel Social] Error buscando usuarios:", error);
      throw error;
    }

    const user = await getUser();

    return (data || [])
      .filter(profile => profile.id !== user.id)
      .map(normalizeProfile);
  }

  async function getProfile(userId) {
    if (!userId) return null;

    const client = getClient();

    const { data, error } = await client
      .from("profiles")
      .select(
        "id, username, display_name, avatar_url, bio, is_private, is_public"
      )
      .eq("id", userId)
      .maybeSingle();

    if (error) throw error;

    return normalizeProfile(data);
  }

  /* =========================================
     SEGUIR USUARIOS
     Esquema esperado:
     follows.follower_id
     follows.following_id
  ========================================= */

  async function follow(userId) {
    const user = await getUser();

    if (!userId || userId === user.id) {
      throw new Error("No podés seguir tu propio perfil.");
    }

    const client = getClient();

    const profile = await getProfile(userId);

    if (!profile) {
      throw new Error("Este usuario no existe o no está disponible.");
    }

    if (profile.is_private) {
      throw new Error("Este perfil es privado. Necesitás autorización para seguirlo.");
    }

    const { error } = await client
      .from("follows")
      .insert({
        follower_id: user.id,
        following_id: userId
      });

    if (error) {
      if (error.code === "23505") {
        throw new Error("Ya seguís a este usuario.");
      }

      console.error("[Shunel Social] Error siguiendo:", error);
      throw error;
    }

    await refreshConnections();

    dispatch("shunel:user-followed", {
      userId,
      profile
    });

    return true;
  }

  async function unfollow(userId) {
    const user = await getUser();

    if (!userId || userId === user.id) {
      throw new Error("Usuario no válido.");
    }

    const client = getClient();

    const { error } = await client
      .from("follows")
      .delete()
      .eq("follower_id", user.id)
      .eq("following_id", userId);

    if (error) {
      console.error("[Shunel Social] Error dejando de seguir:", error);
      throw error;
    }

    await refreshConnections();

    dispatch("shunel:user-unfollowed", { userId });

    return true;
  }

  /* =========================================
     CONSULTAR CONEXIONES
  ========================================= */

  async function getFollowing(userId = null) {
    const user = await getUser();
    const targetId = userId || user.id;
    const client = getClient();

    const { data, error } = await client
      .from("follows")
      .select("following_id")
      .eq("follower_id", targetId);

    if (error) throw error;

    const ids = (data || []).map(item => item.following_id);

    if (!ids.length) return [];

    const { data: profiles, error: profileError } = await client
      .from("profiles")
      .select(
        "id, username, display_name, avatar_url, bio, is_private, is_public"
      )
      .in("id", ids);

    if (profileError) throw profileError;

    return (profiles || []).map(normalizeProfile);
  }

  async function getFollowers(userId = null) {
    const user = await getUser();
    const targetId = userId || user.id;
    const client = getClient();

    const { data, error } = await client
      .from("follows")
      .select("follower_id")
      .eq("following_id", targetId);

    if (error) throw error;

    const ids = (data || []).map(item => item.follower_id);

    if (!ids.length) return [];

    const { data: profiles, error: profileError } = await client
      .from("profiles")
      .select(
        "id, username, display_name, avatar_url, bio, is_private, is_public"
      )
      .in("id", ids);

    if (profileError) throw profileError;

    return (profiles || []).map(normalizeProfile);
  }

  async function isFollowing(userId) {
    const user = await getUser();

    if (!userId || userId === user.id) return false;

    const client = getClient();

    const { data, error } = await client
      .from("follows")
      .select("follower_id")
      .eq("follower_id", user.id)
      .eq("following_id", userId)
      .maybeSingle();

    if (error) throw error;

    return Boolean(data);
  }

  async function refreshConnections() {
    const [following, followers] = await Promise.all([
      getFollowing(),
      getFollowers()
    ]);

    state.following = following;
    state.followers = followers;

    dispatch("shunel:social-updated", {
      following,
      followers,
      followingCount: following.length,
      followersCount: followers.length
    });

    return {
      following,
      followers
    };
  }

  /* =========================================
     CONTADORES
  ========================================= */

  async function getCounts(userId = null) {
    const [following, followers] = await Promise.all([
      getFollowing(userId),
      getFollowers(userId)
    ]);

    return {
      following: following.length,
      followers: followers.length
    };
  }

  /* =========================================
     RENDERIZADO DE USUARIOS
  ========================================= */

  function renderUsers(container, profiles, options = {}) {
    if (!container) return;

    container.replaceChildren();

    if (!profiles.length) {
      const empty = document.createElement("p");
      empty.className = "social-empty";
      empty.textContent = options.emptyMessage || "No hay usuarios para mostrar.";
      container.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();

    profiles.forEach(profile => {
      const item = document.createElement("article");
      item.className = "social-user";

      const avatar = document.createElement("img");
      avatar.className = "social-user-avatar";
      avatar.alt = "";
      avatar.loading = "lazy";

      if (profile.avatar_url) {
        avatar.src = profile.avatar_url;
      }

      const information = document.createElement("div");
      information.className = "social-user-information";

      const name = document.createElement("strong");
      name.textContent = profile.display_name;

      const username = document.createElement("span");
      username.textContent = `@${profile.username}`;

      const bio = document.createElement("small");
      bio.textContent = profile.bio || "";

      information.append(name, username);

      if (profile.bio) {
        information.appendChild(bio);
      }

      item.append(avatar, information);

      if (options.showFollowButton && profile.id !== state.user?.id) {
        const button = document.createElement("button");

        button.type = "button";
        button.className = "social-follow-button";
        button.textContent = "Seguir";

        button.addEventListener("click", async () => {
          button.disabled = true;

          try {
            await follow(profile.id);
            button.textContent = "Siguiendo";
          } catch (error) {
            button.textContent = "Seguir";
            dispatch("shunel:toast", {
              message: error.message || "No se pudo seguir al usuario."
            });
          } finally {
            button.disabled = false;
          }
        });

        item.appendChild(button);
      }

      item.addEventListener("click", event => {
        if (event.target.closest("button")) return;

        dispatch("shunel:open-profile", {
          userId: profile.id,
          profile
        });
      });

      fragment.appendChild(item);
    });

    container.appendChild(fragment);
  }

  /* =========================================
     INICIALIZACIÓN
  ========================================= */

  async function initialize() {
    if (state.initialized) return;

    state.initialized = true;

    window.ShunelSocial = {
      searchUsers,
      getProfile,
      follow,
      unfollow,
      getFollowing,
      getFollowers,
      isFollowing,
      refreshConnections,
      getCounts,
      renderUsers,

      getState: () => ({
        user: state.user,
        following: [...state.following],
        followers: [...state.followers],
        loading: state.loading
      })
    };

    try {
      await getUser();
      await refreshConnections();
    } catch (error) {
      console.info(
        "[Shunel Social] Esperando una sesión autenticada:",
        error.message
      );
    }

    dispatch("shunel:social-ready");

    console.info("[Shunel Social] Módulo preparado.");
  }

  initialize();

})();
