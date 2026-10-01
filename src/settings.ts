import * as vscode from 'vscode';

export interface Settings {
  configuration: string;
  platform: string;
  solutionPlatform: string;
  restoreBeforeSolutionBuild: boolean;
  debugType: string;
  buildProjectReferences: boolean;
  buildChangedReferences: boolean;
  buildBeforeRun: boolean;
  additionalMsbuildArgs: string[];
  msbuildPath: string;
  iisExpressPath: string;
  applicationPool: string;
  bindAllHostnames: boolean;
  justMyCode: boolean;
  stopSitesWhenDebuggingStops: boolean;
  startupTimeoutSeconds: number;
  generateDesignerOnSave: boolean;
}

export function getSettings(): Settings {
  const c = vscode.workspace.getConfiguration('remoteSshWebForm');
  return {
    configuration: c.get('configuration', 'Debug'),
    platform: c.get('platform', 'AnyCPU'),
    solutionPlatform: c.get('solutionPlatform', 'Any CPU'),
    restoreBeforeSolutionBuild: c.get('restoreBeforeSolutionBuild', true),
    debugType: c.get('debugType', 'portable'),
    buildProjectReferences: c.get('buildProjectReferences', false),
    buildChangedReferences: c.get('buildChangedReferences', true),
    buildBeforeRun: c.get('buildBeforeRun', true),
    additionalMsbuildArgs: c.get<string[]>('additionalMsbuildArgs', []),
    msbuildPath: c.get('msbuildPath', ''),
    iisExpressPath: c.get('iisExpressPath', ''),
    applicationPool: c.get('applicationPool', 'Clr4IntegratedAppPool'),
    bindAllHostnames: c.get('bindAllHostnames', true),
    justMyCode: c.get('justMyCode', true),
    stopSitesWhenDebuggingStops: c.get('stopSitesWhenDebuggingStops', true),
    startupTimeoutSeconds: c.get('startupTimeoutSeconds', 60),
    generateDesignerOnSave: c.get('generateDesignerOnSave', true),
  };
}
