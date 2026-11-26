import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import "./style.css";
import App from "./App.vue";
import Dashboard from "./pages/Dashboard.vue";
import Instances from "./pages/Instances.vue";
import Tables from "./pages/Tables.vue";
import Monitor from "./pages/Monitor.vue";
import Backups from "./pages/Backups.vue";
import Settings from "./pages/Settings.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Dashboard, meta: { title: "Overview" } },
    { path: "/instances", component: Instances, meta: { title: "Databases" } },
    { path: "/instances/:id/tables", component: Tables, meta: { title: "Tabel" } },
    { path: "/monitor", component: Monitor, meta: { title: "Monitor" } },
    { path: "/backups", component: Backups, meta: { title: "Backups" } },
    { path: "/settings", component: Settings, meta: { title: "Settings" } },
  ],
});

createApp(App).use(router).mount("#app");
