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
  loginError.value = "";
  const res = await api.api.auth.login.post({
    password: password.value,
    totpCode: totpRequired.value ? totpCode.value : undefined,
  });
  if (res.data?.ok) {
    authenticated.value = true;
    password.value = "";
    totpCode.value = "";
  } else {
    loginError.value = res.data?.error || "Kata sandi atau kode 2FA salah";
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
  <div v-if="checking" class="flex min-h-screen items-center justify-center bg-neutral-950 text-sm text-neutral-400">
    <AppIcon name="spinner" size="md" class="animate-spin mr-2" />
    <span>Memuat...</span>
  </div>

  <div v-else-if="!authenticated" class="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
    <form
      @submit.prevent="login"
      class="w-full max-w-sm space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900 p-6 shadow-md"
    >
      <div class="flex items-center gap-2.5">
        <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
          <AppIcon name="storage" size="md" />
        </div>
        <div>
          <h1 class="text-base font-extrabold tracking-tight text-neutral-100">PG Panel</h1>
          <p class="text-xs text-neutral-400">Console Manajemen PostgreSQL</p>
        </div>
      </div>

      <div class="space-y-3">
        <input
          v-model="password"
          type="password"
          placeholder="Kata sandi admin"
          autofocus
          class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-emerald-500 focus:outline-none focus:ring-3 focus:ring-emerald-500/15"
        />
        <input
          v-if="totpRequired"
          v-model="totpCode"
          type="text"
          inputmode="numeric"
          maxlength="6"
          placeholder="Kode TOTP 6 digit"
          class="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 text-sm font-mono tracking-wider text-neutral-100 placeholder:text-neutral-500 focus:border-emerald-500 focus:outline-none"
        />
      </div>

      <div v-if="loginError" class="text-xs text-rose-400">{{ loginError }}</div>

      <button
        type="submit"
        class="w-full rounded-xl bg-white py-2.5 text-sm font-semibold text-neutral-950 transition-all duration-150 hover:bg-neutral-200 hover:scale-[1.01] active:scale-[0.98]"
      >
        Masuk
      </button>
    </form>
  </div>

  <!-- Full-Viewport Docked Hairline Workspace -->
  <div v-else class="flex min-h-screen w-full bg-neutral-950 text-neutral-100">
    <div
      v-if="mobileMenuOpen"
      @click="mobileMenuOpen = false"
      class="fixed inset-0 z-30 bg-black/60 backdrop-blur-xs md:hidden"
    />

    <!-- Docked Sidebar -->
    <aside
      :class="mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'"
      class="fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/95 transition-transform duration-200 md:static"
    >
      <RouterLink
        to="/settings"
        @click="mobileMenuOpen = false"
        class="flex h-14 items-center justify-between border-b border-neutral-800 px-4 transition hover:bg-neutral-800/40"
        title="Pengaturan"
      >
        <div class="flex items-center gap-2.5">
          <span class="h-2.5 w-2.5 rounded-xs bg-emerald-400"></span>
          <span class="font-extrabold tracking-tight text-neutral-100">PG Panel</span>
        </div>
        <span class="rounded-sm bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">v2.2</span>
      </RouterLink>

      <nav class="flex-1 divide-y divide-neutral-800/40 p-2">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          @click="mobileMenuOpen = false"
          class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-neutral-400 transition hover:bg-neutral-800/60 hover:text-neutral-100"
          active-class="bg-neutral-800/80 text-white font-semibold"
        >
          <AppIcon :name="item.icon" size="sm" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="border-t border-neutral-800 p-2">
        <button
          @click="logout"
          class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs text-neutral-400 transition hover:bg-neutral-800 hover:text-rose-400"
        >
          <span>Keluar</span>
          <AppIcon name="logout" size="sm" />
        </button>
      </div>
    </aside>

    <!-- Full-Width Main Workspace -->
    <div class="flex min-w-0 flex-1 flex-col">
      <header class="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-neutral-800 bg-neutral-900/80 px-4 backdrop-blur md:px-6">
        <div class="flex min-w-0 items-center gap-3">
          <button
            @click="mobileMenuOpen = !mobileMenuOpen"
            class="-ml-1.5 rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 md:hidden"
            aria-label="Menu"
          >
            <AppIcon name="menu" size="lg" />
          </button>
          <h1 class="truncate text-base font-extrabold tracking-tight text-neutral-100">
            {{ pageTitle }}
          </h1>
        </div>

        <button
          v-if="route.path !== '/instances'"
          @click="goCreateDb"
          class="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-neutral-950 transition-all duration-150 hover:bg-neutral-200 hover:scale-[1.02] active:scale-[0.98]"
        >
          <AppIcon name="plus" size="xs" />
          <span>Tambah</span>
        </button>
      </header>

      <main class="flex-1 w-full">
        <RouterView />
      </main>
    </div>

    <AppToast />
  </div>
</template>
