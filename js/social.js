
/* =========================================
   SHUNEL — SOCIAL ENGINE
   Seguidores, seguidos y comunidad
   Version: 2.0.0
========================================= */

(() => {
  "use strict";

  if (window.ShunelSocial) return;

  const CONFIG = {
    table: "follows",
    cacheKey: "shunel_social_cache",
    pageSize: 50
  };

  const state = {
    initialized: false,
    loading: false,
    currentUser: null,
    following: [],
    followers: [],
    operations: new Set(),
    client: null
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

  function getClient() {
    return state.client || getSupabase();
  }

  function normalizeId(value) {
    return String(value || "").trim();
  }

  function readCache() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(CONFIG.cacheKey) || "{}"
      );

      return saved && typeof saved === "object"
        ? saved
        : {};
    } catch {
      return {};
    }
  }

  function saveCache() {
    try {
      localStorage.setItem(
        CONFIG.cacheKey,
        JSON.stringify({
          userId: state.currentUser,
          following: state.following,
          followers: state.followers,
          updatedAt: Date.now()
        })
      );
    } catch (error) {
      console.warn(
        "[Shunel Social] No se pudo guardar la caché:",
        error
      );
    }
  }

  async function getAuthenticatedUser() {
    const client = getClient();

    if (!client?.auth) return null;

    const { data, error } = await client.auth.getUser();

    if (error) throw error;

    return data?.user || null;
  }

  function hasFollowed(userId) {
    const id = normalizeId(userId);

    return state.following.some(
      item => item.following_id === id
    );
  }

  function hasFollower(userId) {
    const id = normalizeId(userId);

    return state.followers.some(
      item => item.follower_id === id
    );
  }

  async function load() {
    if (state.loading) {
      return getState();
    }

    state.loading = true;

    emit("social:loading", {
      loading: true
    });

    try {
      const client = getClient();

      if (!client) {
        const cache = readCache();

        state.currentUser = cache.userId || null;
        state.following = cache.following || [];
        state.followers = cache.followers || [];

        emit("social:offline", {
          following: state.following,
          followers: state.followers
        });

        return getState();
      }

      const user = await getAuthenticatedUser();

      if (!user) {
        state.currentUser = null;
        state.following = [];
        state.followers = [];

        emit("social:logged-out", {});

        return getState();
      }

      state.currentUser = user.id;

      const [followingResult, followersResult] =
        await Promise.all([
          client
            .from(CONFIG.table)
            .select("follower_id, following_id, created_at")
            .eq("follower_id", user.id)
            .order("created_at", { ascending: false })
            .limit(CONFIG.pageSize),

          client
            .from(CONFIG.table)
            .select("follower_id, following_id, created_at")
            .eq("following_id", user.id)
            .order("created_at", { ascending: false })
            .limit(CONFIG.pageSize)
        ]);

      if (followingResult.error) {
        throw followingResult.error;
      }

      if (followersResult.error) {
        throw followersResult.error;
      }

      state.following = followingResult.data || [];
      state.followers = followersResult.data || [];

      saveCache();

      emit("social:loaded", {
        following: state.following,
        followers: state.followers,
        followingCount: state.following.length,
        followersCount: state.followers.length
      });

      return getState();

    } catch (error) {
      console.error(
        "[Shunel Social] Error cargando relaciones:",
        error
      );

      emit("social:error", {
        message: error.message
      });

      throw error;

    } finally {
      state.loading = false;

      emit("social:loading", {
        loading: false
      });
    }
  }

  async function follow(userId) {
    const targetId = normalizeId(userId);

    if (!targetId) {
      throw new Error("El usuario indicado no es válido.");
    }

    if (!state.currentUser) {
      throw new Error("Debes iniciar sesión para seguir usuarios.");
    }

    if (targetId === state.currentUser) {
      throw new Error("No puedes seguirte a ti mismo.");
    }

    if (hasFollowed(targetId)) {
      return {
        success: true,
        alreadyFollowing: true
      };
    }

    const operationId = `follow:${targetId}`;

    if (state.operations.has(operationId)) {
      return {
        success: false,
        pending: true
      };
    }

    const client = getClient();

    if (!client) {
      throw new Error("No hay conexión con Supabase.");
    }

    state.operations.add(operationId);

    try {
      const { data, error } = await client
        .from(CONFIG.table)
        .insert({
          follower_id: state.currentUser,
          following_id: targetId
        })
        .select()
        .single();

      if (error) throw error;

      state.following = [
        {
          follower_id: state.currentUser,
          following_id: targetId,
          created_at: data.created_at
        },
        ...state.following
      ];

      saveCache();

      emit("social:followed", {
        userId: targetId,
        relationship: data
      });

      return {
        success: true,
        alreadyFollowing: false
      };

    } catch (error) {
      emit("social:error", {
        action: "follow",
        userId: targetId,
        message: error.message
      });

      throw error;

    } finally {
      state.operations.delete(operationId);
    }
  }

  async function unfollow(userId) {
    const targetId = normalizeId(userId);

    if (!targetId) {
      throw new Error("El usuario indicado no es válido.");
    }

    if (!state.currentUser) {
      throw new Error("Debes iniciar sesión.");
    }

    if (!hasFollowed(targetId)) {
      return {
        success: true,
        alreadyUnfollowed: true
      };
    }

    const operationId = `unfollow:${targetId}`;

    if (state.operations.has(operationId)) {
      return {
        success: false,
        pending: true
      };
    }

    const client = getClient();

    if (!client) {
      throw new Error("No hay conexión con Supabase.");
    }

    state.operations.add(operationId);

    try {
      const { error } = await client
        .from(CONFIG.table)
        .delete()
        .eq("follower_id", state.currentUser)
        .eq("following_id", targetId);

      if (error) throw error;

      state.following = state.following.filter(
        item => item.following_id !== targetId
      );

      saveCache();

      emit("social:unfollowed", {
        userId: targetId
      });

      return {
        success: true,
        alreadyUnfollowed: false
      };

    } catch (error) {
      emit("social:error", {
        action: "unfollow",
        userId: targetId,
        message: error.message
      });

      throw error;

    } finally {
      state.operations.delete(operationId);
    }
  }

  async function toggleFollow(userId) {
    return hasFollowed(userId)
      ? unfollow(userId)
      : follow(userId);
  }

  async function checkFollow(userId) {
    const targetId = normalizeId(userId);

    if (!targetId || !state.currentUser) {
      return false;
    }

    const client = getClient();

    if (!client) {
      return hasFollowed(targetId);
    }

    const { data, error } = await client
      .from(CONFIG.table)
      .select("follower_id")
      .eq("follower_id", state.currentUser)
      .eq("following_id", targetId)
      .maybeSingle();

    if (error) throw error;

    const following = Boolean(data);

    if (following && !hasFollowed(targetId)) {
      state.following.push({
        follower_id: state.currentUser,
        following_id: targetId
      });
    }

    if (!following) {
      state.following = state.following.filter(
        item => item.following_id !== targetId
      );
    }

    saveCache();

    return following;
  }

  function getFollowing() {
    return [...state.following];
  }

  function getFollowers() {
    return [...state.followers];
  }

  function getCounts() {
    return {
      following: state.following.length,
      followers: state.followers.length
    };
  }

  function getState() {
    return {
      initialized: state.initialized,
      loading: state.loading,
      currentUser: state.currentUser,
      following: getFollowing(),
      followers: getFollowers(),
      ...getCounts()
    };
  }

  function setClient(client) {
    if (
      !client?.auth ||
      typeof client.from !== "function"
    ) {
      return false;
    }

    state.client = client;

    return true;
  }

  function clear() {
    state.currentUser = null;
    state.following = [];
    state.followers = [];
    state.operations.clear();

    try {
      localStorage.removeItem(CONFIG.cacheKey);
    } catch {}

    emit("social:cleared", {});

    return true;
  }

  function initialize() {
    if (state.initialized) return;

    const cache = readCache();

    state.currentUser = cache.userId || null;
    state.following = cache.following || [];
    state.followers = cache.followers || [];

    state.client = getSupabase();
    state.initialized = true;

    emit("social:ready", {});

    console.info("[Shunel Social] Sistema preparado.");
  }

  window.ShunelSocial = Object.freeze({
    initialize,
    load,
    follow,
    unfollow,
    toggleFollow,
    checkFollow,
    hasFollowed,
    hasFollower,
    getFollowing,
    getFollowers,
    getCounts,
    getState,
    setClient,
    clear
  });

  initialize();

})();
