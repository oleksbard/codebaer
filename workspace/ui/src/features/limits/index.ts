import { defineFeature } from '#kernel/registry';
import { LIMIT_PROVIDERS } from '#ipc/settings';
import { limitsOn, refreshLimits } from './limits';

export const limits = defineFeature({
  id: 'limits',
  commands: [{
    id: 'limits.refresh', label: 'Refresh Usage Limits', when: () => LIMIT_PROVIDERS.some(limitsOn),
    run: () => void refreshLimits(true),
  }],
});

export { startLimits } from './limits';
export { LimitsPills } from './LimitsPill';
