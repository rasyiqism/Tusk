<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { api } from "./lib/api";
import AppIcon from "./components/AppIcon.vue";
import AppToast from "./components/AppToast.vue";

const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const totpRequired = ref(false);
const checking = ref(true);
const loggingIn = ref(false);
const password = ref("");
const totpCode = ref("");
const loginError = ref("");
const mobileMenuOpen = ref(false);

const pageTitle = computed(() => String(route.meta?.title || "Overview"));

const navItems = [
  { to: "/", label: "Overview", icon: "dashboard" },
  { to: "/instances", label: "Databases", icon: "storage" },
  { to: "/monitor", label: "Monitor", icon: "analytics" },
  { to: "/backups", label: "Backups", icon: "upload" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

async function checkAuth() {
  checking.value = true;
  const res = await api.api.auth.me.get();
  authenticated.value = Boolean(res.data?.authenticated);
  totpRequired.value = Boolean(res.data?.totpRequired);
  checking.value = false;
}

async function login() {
  if (loggingIn.value || !password.value) return;
  loginError.value = "";
  loggingIn.value = true;
  const res = await api.api.auth.login.post({
    password: password.value,
    totpCode: totpRequired.value ? totpCode.value : undefined,
  });
  loggingIn.value = false;
  if (res.data?.ok) {
    authenticated.value = true;
    password.value = "";
    totpCode.value = "";
  } else {
    loginError.value = res.data?.error || "Invalid password or 2FA code";
  }
}

async function logout() {
  await api.api.auth.logout.post();
  await checkAuth();
}

function goCreateDb() {
  router.push({ path: "/instances", query: { create: String(Date.now()) } });
}

onMounted(checkAuth);
</script>

<template>
  <div v-if="checking" class="flex min-h-screen items-center justify-center bg-neutral-50 text-sm text-neutral-600">
    <AppIcon name="spinner" size="md" class="animate-spin mr-2" />
    <span>Loading...</span>
  </div>

  <div v-else-if="!authenticated" class="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
    <form
      @submit.prevent="login"
      class="w-full max-w-sm space-y-4 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm"
    >
      <div class="flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-600">
          <AppIcon name="tusk" size="lg" />
        </div>
        <div>
          <h1 class="text-base font-extrabold tracking-tight text-neutral-900">Tusk</h1>
          <p class="text-xs text-neutral-600">PostgreSQL Control Panel</p>
        </div>
      </div>

      <div class="space-y-3">
        <input
          v-model="password"
          type="password"
          placeholder="Admin password"
          autofocus
          class="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none focus:ring-3 focus:ring-emerald-600/15"
        />
        <input
          v-if="totpRequired"
          v-model="totpCode"
          type="text"
          inputmode="numeric"
          maxlength="6"
          placeholder="6-digit TOTP code"
          class="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm font-mono tracking-wider text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
        />
      </div>

      <div v-if="loginError" class="text-xs text-rose-600">{{ loginError }}</div>

      <button
        type="submit"
        :disabled="loggingIn || !password"
        class="w-full rounded-lg bg-neutral-900 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:bg-neutral-800 hover:scale-[1.01] active:scale-[0.98] disabled:opacity-50"
      >
        {{ loggingIn ? "Verifying..." : "Sign in" }}
      </button>
    </form>
  </div>

  <!-- Full-Viewport Docked Hairline Workspace -->
  <div v-else class="flex min-h-screen w-full bg-neutral-50 text-neutral-900">
    <div
      v-if="mobileMenuOpen"
      @click="mobileMenuOpen = false"
      class="fixed inset-0 z-30 bg-neutral-950/35 backdrop-blur-xs md:hidden"
    />

    <!-- Docked Sidebar -->
    <aside
      :class="mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'"
      class="fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-white transition-transform duration-200 md:sticky md:top-0 md:h-screen md:overflow-y-auto"
    >
      <RouterLink
        to="/settings"
        @click="mobileMenuOpen = false"
        class="flex h-14 items-center justify-between border-b border-neutral-200 px-4 transition hover:bg-neutral-50"
        title="Settings"
      >
        <div class="flex items-center gap-2.5">
          <AppIcon name="tusk" size="md" class="text-emerald-600" />
          <span class="font-extrabold tracking-tight text-neutral-900">Tusk</span>
        </div>
        <span class="rounded-sm bg-neutral-100 border border-neutral-200 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600">v2.4</span>
      </RouterLink>

      <nav class="flex-1 divide-y divide-neutral-100 p-2">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          @click="mobileMenuOpen = false"
          class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
          active-class="bg-neutral-100 text-neutral-900 font-semibold"
        >
          <AppIcon :name="item.icon" size="sm" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="border-t border-neutral-200 p-2">
        <button
          @click="logout"
          class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs text-neutral-600 transition hover:bg-rose-50 hover:text-rose-700"
        >
          <span>Sign out</span>
          <AppIcon name="logout" size="sm" />
        </button>
      </div>
    </aside>

    <!-- Full-Width Main Workspace -->
    <div class="flex min-w-0 flex-1 flex-col bg-white">
      <header class="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-neutral-200 bg-white/90 px-4 backdrop-blur md:px-6">
        <div class="flex min-w-0 items-center gap-3">
          <button
            @click="mobileMenuOpen = !mobileMenuOpen"
            class="-ml-1.5 rounded-lg p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 md:hidden"
            aria-label="Menu"
          >
            <AppIcon name="menu" size="lg" />
          </button>
          <h1 class="truncate text-base font-extrabold tracking-tight text-neutral-900">
            {{ pageTitle }}
          </h1>
        </div>

        <button
          v-if="route.path === '/' || route.path === '/instances'"
          @click="goCreateDb"
          class="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white transition-all duration-150 hover:bg-neutral-800 hover:scale-[1.02] active:scale-[0.98]"
        >
          <AppIcon name="plus" size="xs" />
          <span>Add</span>
        </button>
      </header>

      <main class="flex-1 w-full bg-white">
        <RouterView />
      </main>
    </div>

    <AppToast />
  </div>
</template>
