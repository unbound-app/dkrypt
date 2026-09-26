import { Type, type Static } from '@sinclair/typebox';

export const identifierSchema = Type.String({ minLength: 1, maxLength: 200 });
export const projectIdentifierPattern = /^[A-Za-z0-9_-]{1,80}$/;
export const projectIdentifierSchema = Type.String({ minLength: 1, maxLength: 80, pattern: projectIdentifierPattern.source });
export const deviceTransportSchema = Type.Union([Type.Literal('wifi'), Type.Literal('usb')]);

export type DeviceTransport = Static<typeof deviceTransportSchema>;

export const paginationQueryProperties = {
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};

export const paginationQuerySchema = Type.Object(paginationQueryProperties, { additionalProperties: true });
