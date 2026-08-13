import { configureStore } from "@reduxjs/toolkit";
import authReducer from "@/features/auth/authSlice";
import setupReducer from "@/features/setup/setupSlice";
import uiReducer from "@/features/ui/uiSlice";
import imagesReducer from "@/features/images/imagesSlice";
import registriesReducer from "@/features/registries/registriesSlice";
import secretsReducer from "@/features/secrets/secretsSlice";
import containersReducer from "@/features/containers/containersSlice";
import gitopsReducer from "@/features/gitops/gitopsSlice";
import clustersReducer from "@/features/clusters/clustersSlice";
import notificationsReducer from "@/features/notifications/notificationsSlice";
import volumesReducer from "@/features/volumes/volumesSlice";
import networksReducer from "@/features/networks/networksSlice";
import auditReducer from "@/features/audit/auditSlice";
import topologyReducer from "@/features/topology/topologySlice";
import iacReducer from "@/features/iac/iacSlice";
import reverseProxyReducer from "@/features/reverseProxy/reverseProxySlice";
import remoteEnvironmentsReducer from "@/features/remoteEnvironments/remoteEnvironmentsSlice";
import githubReducer from "@/features/github/githubSlice";
import adDnsReducer from "@/features/adDns/adDnsSlice";
import notificationChannelsReducer from "@/features/notificationChannels/notificationChannelsSlice";
import backupsReducer from "@/features/backups/backupsSlice";
import cronJobsReducer from "@/features/cronJobs/cronJobsSlice";
import automationReducer from "@/features/automation/automationSlice";
import { errorNotificationMiddleware } from "@/features/notifications/errorNotificationMiddleware";

export const store = configureStore({
  reducer: {
    auth: authReducer,
    setup: setupReducer,
    ui: uiReducer,
    images: imagesReducer,
    registries: registriesReducer,
    secrets: secretsReducer,
    containers: containersReducer,
    gitops: gitopsReducer,
    clusters: clustersReducer,
    notifications: notificationsReducer,
    volumes: volumesReducer,
    networks: networksReducer,
    audit: auditReducer,
    topology: topologyReducer,
    iac: iacReducer,
    reverseProxy: reverseProxyReducer,
    remoteEnvironments: remoteEnvironmentsReducer,
    github: githubReducer,
    adDns: adDnsReducer,
    notificationChannels: notificationChannelsReducer,
    backups: backupsReducer,
    cronJobs: cronJobsReducer,
    automation: automationReducer,
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(errorNotificationMiddleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
