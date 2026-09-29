import { Type } from '@sinclair/typebox';

export const deploymentMetadataSchema = Type.Object({ id: Type.String(), ref: Type.String() });
