export type Role = 'DEVELOPER' | 'ADMIN' | 'DIRECTOR' | 'COORDINATOR' | 'STORE_MANAGER' | 'PROMOTER';
export type Capability =
  | 'matrix.view' | 'stores.manage' | 'territory.manage' | 'campaigns.manage' | 'tracking.view' | 'reports.view'
  | 'users.manage' | 'devices.manage' | 'audit.view' | 'system.view' | 'apikeys.manage' | 'integration.manage' | 'infra.destructive';

export interface Me {
  id: string; name: string; email: string; role: Role; roleLabel: string; capabilities: Capability[];
  mustChangePassword: boolean; hasPin: boolean;
  stores: 'ALL' | { id: string; code: string; name: string }[];
}

export interface LatLng { lat: number; lng: number }

export interface Store {
  id: string; code: string; name: string; address: string | null; location: LatLng | null; status: 'ACTIVE' | 'INACTIVE';
  activeCampaigns: number; liveSessions: number; areas: number; lastActivityAt: string | null; operating: boolean;
}

export interface Area {
  id: string; storeId: string; name: string; kind: 'RADIUS' | 'POLYGON'; center: LatLng | null; radiusM: number | null;
  geometry: { type: 'Polygon'; coordinates: [number, number][][] }; areaM2: number; archived: boolean;
}

export interface Poi { id: string; storeId: string; name: string; category: string; notes: string | null; location: LatLng }

export type CampaignStatus = 'DRAFT' | 'PLANNED' | 'ACTIVE' | 'PAUSED' | 'FINISHED' | 'CANCELLED';
export interface Campaign {
  id: string; storeId: string; storeName: string; storeCode: string; name: string; description: string | null;
  status: CampaignStatus; statusLabel: string; areaId: string | null; areaName: string | null;
  startDate: string | null; endDate: string | null; streetsCount: number; plannedLengthM: number;
  sessionsCount: number; liveSessions: number; assignees: { id: string; name: string }[];
  coverage: { status: string; percent: number | null; computedAt: string } | null;
}

export interface SessionInfo {
  id: string; campaignId: string; campaignName: string; storeId: string; storeName: string; storeCode: string;
  userId: string; userName: string; device: { name: string; kind: string } | null;
  status: string; state: string; stateLabel: string; startedAt: string | null; finishedAt: string | null; finishReason: string | null;
  pointsCount: number; acceptedPoints: number; pendingPointsReported: number;
  lastPointCapturedAt: string | null; lastPointReceivedAt: string | null;
  lastPosition: { lat: number; lng: number; accuracyM: number | null } | null;
}
