export interface DeploymentMetadata {
  id: string;
  ref: string;
}

export function getDeploymentMetadata(): DeploymentMetadata {
  return {
    id: process.env.DEPLOYMENT_ID?.trim() || 'local',
    ref: process.env.BUILD_REF?.trim() || process.env.VITE_BUILD_REF?.trim() || 'development',
  };
}

export function getOtelResourceAttributes(serviceName: string): Array<{ key: string; value: { stringValue: string } }> {
  const deployment = getDeploymentMetadata();
  return [
    { key: 'service.name', value: { stringValue: serviceName } },
    { key: 'service.version', value: { stringValue: deployment.ref } },
    { key: 'deployment.id', value: { stringValue: deployment.id } },
  ];
}
