import { Type, type Static } from '@sinclair/typebox';
import type {
  ApiErrorEnvelope,
  DashboardDeviceActivityResponse,
  DashboardDeviceListResponse,
  DashboardDeviceHealthHistoryResponse,
  DashboardDeviceBatteryHistoryResponse,
  DashboardDeviceTemperatureHistoryResponse,
  DashboardDeviceStorageHistoryResponse,
} from '#contracts.js';
import { identifierSchema, paginationQueryProperties } from '#apiCommonContracts.js';

export const dashboardDeviceParamsSchema = Type.Object({ id: identifierSchema }, { additionalProperties: true });

export const dashboardDeviceHistoryQuerySchema = Type.Object({
  hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })),
}, { additionalProperties: true });

export const dashboardDeviceActivityQuerySchema = Type.Object({
  ...paginationQueryProperties,
}, { additionalProperties: true });

export type DashboardDeviceListRoute = {
  Reply: { 200: DashboardDeviceListResponse };
};

export type DashboardDeviceActivityRoute = {
  Params: Static<typeof dashboardDeviceParamsSchema>;
  Querystring: Static<typeof dashboardDeviceActivityQuerySchema>;
  Reply: { 200: DashboardDeviceActivityResponse; 404: ApiErrorEnvelope };
};

export type DashboardDeviceHealthHistoryRoute = {
  Params: Static<typeof dashboardDeviceParamsSchema>;
  Querystring: Static<typeof dashboardDeviceHistoryQuerySchema>;
  Reply: { 200: DashboardDeviceHealthHistoryResponse };
};

export type DashboardDeviceBatteryHistoryRoute = {
  Params: Static<typeof dashboardDeviceParamsSchema>;
  Querystring: Static<typeof dashboardDeviceHistoryQuerySchema>;
  Reply: { 200: DashboardDeviceBatteryHistoryResponse };
};

export type DashboardDeviceTemperatureHistoryRoute = {
  Params: Static<typeof dashboardDeviceParamsSchema>;
  Querystring: Static<typeof dashboardDeviceHistoryQuerySchema>;
  Reply: { 200: DashboardDeviceTemperatureHistoryResponse };
};

export type DashboardDeviceStorageHistoryRoute = {
  Params: Static<typeof dashboardDeviceParamsSchema>;
  Querystring: Static<typeof dashboardDeviceHistoryQuerySchema>;
  Reply: { 200: DashboardDeviceStorageHistoryResponse };
};
