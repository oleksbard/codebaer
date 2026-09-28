import { setKeymap } from '#kernel/keymap';
import { platform } from '#kernel/platform';
import { LINUX } from './linux';
import { MAC } from './mac';

setKeymap(platform() === 'linux' ? LINUX : MAC);
