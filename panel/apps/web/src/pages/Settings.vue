<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../lib/api";
import { useToast } from "../components/useToast";
import AppIcon from "../components/AppIcon.vue";
import TableSkeleton from "../components/TableSkeleton.vue";

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
const loading = ref(true);
const loadError = ref(false);
const saving = ref(false);
const testingAlert = ref(false);
const auditEvents = ref<AuditEvent[]>([]);

async function load() {
  loading.value = auditEvents.value.length === 0 && !publicHost.value;
  loadError.value = false;
  try {
    const [sRes, aRes] = await Promise.all([
      api.api.settings.get(),
      api.api.settings.audit.get(),
    ]);
    if (sRes.error && aRes.error) {
      loadError.value = true;
      return;
    }
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
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

async function saveSettings() {
  if (saving.value) return;
  saving.value = true;
  try {
    const res = await api.api.settings.put({
      ntfy_url: ntfyUrl.value.trim(),
      alert_webhook_url: webhookUrl.value.trim(),
      disk_alert_pct: diskPct.value,
      ram_alert_pct: ramPct.value,
      public_db_host: publicHost.value.trim() || "localhost",
      ssl_mode: sslMode.value,
    });
    if (res.data && "ok" in res.data && res.data.ok) {
      toast.success("Settings saved");
      await load();
    } else {
      const err = res.data && "error" in res.data ? String(res.data.error) : "Failed to save";
      toast.error(err);
    }
  } finally {
    saving.value = false;
  }
}

async function testAlert() {
  if (testingAlert.value) return;
  testingAlert.value = true;
  try {
    const res = await api.api.settings["test-alert"].post();
    if (res.data && "ok" in res.data && res.data.ok) {
      const channels = "channels" in res.data && Array.isArray(res.data.channels) ? res.data.channels.join(", ") : "";
      toast.success(channels ? `Sent via ${channels}` : "Test alert sent");
    } else {
      const err =
        (res.data && "error" in res.data && String(res.data.error)) ||
        (res.error?.value && typeof res.error.value === "object" && "error" in res.error.value
          ? String((res.error.value as { error: unknown }).error)
          : "Failed to send test alert");
      toast.error(err);
    }
  } finally {
    testingAlert.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="w-full divide-y divide-neutral-200">
    <!-- Error Retry Banner -->
    <div v-if="loadError" class="flex items-center justify-between gap-3 bg-rose-50 px-4 py-3 text-xs text-rose-700 sm:px-6">
      <span>Failed to load settings from server.</span>
      <button
        @click="load"
        class="rounded-lg border border-rose-200 bg-white px-2.5 py-1 font-medium text-rose-700 transition hover:bg-rose-100 active:scale-[0.98]"
      >
        Retry
      </button>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-neutral-200">
      <!-- Left Column: Settings Form -->
      <section class="lg:col-span-5">
        <div class="p-4 sm:p-6 space-y-5 lg:sticky lg:top-14 lg:max-h-[calc(100vh-3.5rem)] lg:overflow-y-auto">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-600">Network &amp; Alerts</h2>

        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <label class="block text-xs font-semibold text-neutral-700">Public DB Host</label>
              <input
                v-model="publicHost"
                placeholder="10.8.0.1 / db.domain.com"
                class="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2 text-sm font-mono text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
              />
            </div>
            <div class="space-y-1.5">
              <label class="block text-xs font-semibold text-neutral-700">SSL Mode</label>
              <select
                v-model="sslMode"
                class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-mono text-neutral-900 focus:border-emerald-600 focus:outline-none"
              >
                <option value="require">require (TLS)</option>
                <option value="prefer">prefer</option>
                <option value="disable">disable (VPN)</option>
              </select>
            </div>
          </div>

          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-700">ntfy URL</label>
            <input
              v-model="ntfyUrl"
              placeholder="https://ntfy.example.com/pg-alerts"
              class="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2 text-sm text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
            />
          </div>

          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-neutral-700">Webhook URL</label>
            <input
              v-model="webhookUrl"
              placeholder="https://hooks.example.com/alert"
              class="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2 text-sm text-neutral-900 placeholder:text-neutral-500 focus:border-emerald-600 focus:outline-none"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <label class="block text-xs font-semibold text-neutral-700">Disk Threshold (%)</label>
              <input
                v-model.number="diskPct"
                type="number"
                min="10"
                max="99"
                class="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2 font-mono text-sm text-neutral-900 focus:border-emerald-600 focus:outline-none"
              />
            </div>
            <div class="space-y-1.5">
              <label class="block text-xs font-semibold text-neutral-700">RAM Threshold (%)</label>
              <input
                v-model.number="ramPct"
                type="number"
                min="10"
                max="99"
                class="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2 font-mono text-sm text-neutral-900 focus:border-emerald-600 focus:outline-none"
              />
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2 pt-2">
          <button
            @click="saveSettings"
            :disabled="saving"
            class="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-neutral-800 active:scale-[0.98] disabled:opacity-50"
          >
            <AppIcon name="save" size="xs" />
            <span>{{ saving ? "Saving..." : "Save" }}</span>
          </button>
          <button
            @click="testAlert"
            :disabled="testingAlert"
            class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-4 py-2 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 active:scale-[0.98] disabled:opacity-50"
          >
            <AppIcon name="bell" size="xs" />
            <span>{{ testingAlert ? "Sending..." : "Test" }}</span>
          </button>
        </div>
        </div>
      </section>

      <!-- Right Column: Audit Trail -->
      <section class="lg:col-span-7">
        <div class="border-b border-neutral-200 px-4 py-3 sm:px-6">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-600">Audit Events</h2>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="border-b border-neutral-200 text-neutral-600">
              <tr>
                <th class="px-4 py-2.5 sm:px-6">Action</th>
                <th class="px-4 py-2.5">Instance</th>
                <th class="px-4 py-2.5 sm:px-6">Detail</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-200/80">
              <TableSkeleton v-if="loading" :rows="5" :cols="3" />
              <tr v-for="ev in auditEvents" :key="ev.id" class="align-middle hover:bg-neutral-50">
                <td class="px-4 py-2.5 sm:px-6">
                  <div class="font-mono font-semibold text-emerald-700">{{ ev.action }}</div>
                  <div class="text-[11px] text-neutral-600">{{ ev.created_at }}</div>
                </td>
                <td class="px-4 py-2.5 font-mono text-neutral-800">{{ ev.instance_name || "-" }}</td>
                <td class="max-w-xs truncate px-4 py-2.5 font-mono text-neutral-600 sm:px-6" :title="ev.detail_json">
                  {{ ev.detail_json }}
                </td>
              </tr>
              <tr v-if="!loading && auditEvents.length === 0">
                <td colspan="3" class="px-4 py-8 text-center text-neutral-600">No audit events recorded yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>
