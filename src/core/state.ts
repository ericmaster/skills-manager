export interface DetectedToolRecord {
  id: string;
  detectedAt: string;
  linkable: boolean;
  linkTarget?: string;
  enabled: boolean;
}

export interface State {
  version: 1;
  tools: DetectedToolRecord[];
  lastDetectedAt?: string;
}
