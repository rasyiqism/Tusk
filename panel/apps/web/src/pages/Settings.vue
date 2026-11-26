<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../lib/api";
import { useToast } from "../components/useToast";
import AppIcon from "../components/AppIcon.vue";

interface AuditEvent {
  id: number;
  instance_name: string | null;
  actor: string;
  ip_address: string | null;
  action: string;
  detail_json: string;
  created_at: string;
}

const toast = useToast();
const ntfyUrl = ref("");
const webhookUrl = ref("");
const diskPct = ref(75);
const ramPct = ref(90);
const publicHost = ref("localhost");
const sslMode = ref<"require" | "prefer" | "disable">("require");
const saving = ref(false);
const auditEvents = ref<AuditEvent[]>([]);

async function load() {
  const [sRes, aRes] = await Promise.all([
    api.api.settings.get(),
    api.api.settings.audit.get(),
  ]);
  if (sRes.data && "settings" in sRes.data && sRes.data.settings) {
    const s = sRes.data.settings;
    ntfyUrl.value = s.ntfy_url;
    webhookUrl.value = s.alert_webhook_url;
    diskPct.value = s.disk_alert_pct;
    ramPct.value = s.ram_alert_pct;
    publicHost.value = s.public_db_host;
    sslMode.value = s.ssl_mode;
  }
  if (aRes.data && "events" in aRes.data) {
    auditEvents.value = aRes.data.events as AuditEvent[];
  }
}

async function saveSettings() {
  saving.value = true;
  const res = await api.api.settings.put({
    ntfy_url: ntfyUrl.value.trim(),
    alert_webhook_url: webhookUrl.value.trim(),
    disk_alert_pct: diskPct.value,
    ram_alert_pct: ramPct.value,
    public_db_host: publicHost.value.trim() || "localhost",
    ssl_mode: sslMode.value,
  });
  saving.value = false;
  if (res.data && "ok" in res.data && res.data.ok) {
    toast.success("Pengaturan tersimpan");
    await load();
  } else {
    const err = res.data && "error" in res.data ? String(res.data.error) : "Gagal menyimpan";
    toast.error(err);
  }
}

async function testAlert() {
  const res = await api.api.settings["test-alert"].post();
  if (res.data && "ok" in res.data && res.data.ok) {
    const channels = "channels" in res.data && Array.isArray(res.data.channels) ? res.data.channels.join(", ") : "";
    toast.success(channels ? `Terkirim via ${channels}` : "Notifikasi uji dikirim");
  } else {
    const err =
      (res.data && "error" in res.data && String(res.data.error)) ||
      (res.error?.value && typeof res.error.value === "object" && "error" in res.error.value
        ? String((res.error.value as { error: unknown }).error)
        : "Gagal mengirim alert uji");
    toast.error(err);
  }
}

onMounted(load);
</script>

<template>
  <div class="w-full grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-neutral-800">
    <!-- Left Column: Settings Form -->
    <section class="lg:col-span-5 p-4 sm:p-6 space-y-5">
      <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">Jaringan & Alert</h2>

      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-300">Host Publik DB</label>
            <input
              v-model="publicHost"
              placeholder="10.8.0.1 / db.domain.com"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-sm font-mono text-neutral-100 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-300">SSL Mode</label>
            <select
              v-model="sslMode"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm font-mono text-neutral-100"
            >
              <option value="require">require (TLS)</option>
              <option value="prefer">prefer</option>
              <option value="disable">disable (VPN)</option>
            </select>
          </div>
        </div>

        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-300">URL ntfy</label>
          <input
            v-model="ntfyUrl"
            placeholder="https://ntfy.example.com/pg-alerts"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div class="space-y-1.5">
          <label class="block text-xs font-semibold text-neutral-300">URL Webhook</label>
          <input
            v-model="webhookUrl"
            placeholder="https://hooks.example.com/alert"
            class="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-300">Batas Disk (%)</label>
            <input
              v-model.number="diskPct"
              type="number"
              min="10"
              max="99"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 font-mono text-sm text-neutral-100"
            />
          </div>
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-300">Batas RAM (%)</label>
            <input
              v-model.number="ramPct"
              type="number"
              min="10"
              max="99"
              class="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 font-mono text-sm text-neutral-100"
            />
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2 pt-2">
        <button
          @click="saveSettings"
          :disabled="saving"
          class="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2 text-xs font-semibold text-neutral-950 transition hover:bg-neutral-200 disabled:opacity-50"
        >
          <AppIcon name="save" size="xs" />
          <span>{{ saving ? "Menyimpan..." : "Simpan" }}</span>
        </button>
        <button
          @click="testAlert"
          class="inline-flex items-center gap-1.5 rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs font-medium text-neutral-200 transition hover:bg-neutral-800"
        >
          <AppIcon name="bell" size="xs" />
          <span>Uji</span>
        </button>
      </div>
    </section>

    <!-- Right Column: Audit Trail -->
    <section class="lg:col-span-7">
      <div class="border-b border-neutral-800 px-4 py-3 sm:px-6">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">Audit Events</h2>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="border-b border-neutral-800 text-neutral-400">
            <tr>
              <th class="px-4 py-2.5 sm:px-6">Aksi</th>
              <th class="px-4 py-2.5">Instance</th>
              <th class="px-4 py-2.5 sm:px-6">Detail</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-800/80">
            <tr v-for="ev in auditEvents" :key="ev.id" class="align-middle hover:bg-neutral-900/60">
              <td class="px-4 py-2.5 sm:px-6">
                <div class="font-mono font-semibold text-indigo-400">{{ ev.action }}</div>
                <div class="text-[11px] text-neutral-500">{{ ev.created_at }}</div>
              </td>
              <td class="px-4 py-2.5 font-mono text-neutral-200">{{ ev.instance_name || "-" }}</td>
              <td class="max-w-xs truncate px-4 py-2.5 font-mono text-neutral-400 sm:px-6" :title="ev.detail_json">
                {{ ev.detail_json }}
              </td>
            </tr>
            <tr v-if="auditEvents.length === 0">
              <td colspan="3" class="px-4 py-8 text-center text-neutral-500">Belum ada audit log.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
