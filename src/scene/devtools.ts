/**
 * Dev-only tuning panel (lil-gui): spacing, riser, leans, sink, fan half-width, spring constants,
 * camera pitch and FOV, lighting and post. Loaded with a dynamic import only in dev (or with ?tune),
 * so it never ships in the production bundle's critical path.
 */

import GUI from 'lil-gui';
import { SPRINGS } from '../motion/spring';
import { DEFAULT_FOCUS_TUNING } from '../motion/focus';
import { setLights } from './materials';
import type { SceneApp } from './sceneApp';
import { tuning } from './tuning';

export function installTuningPanel(app: SceneApp): void {
  const gui = new GUI({ title: 'Crate Digger tuning', width: 300 });
  gui.close();
  const changed = () => app.applyTuning();

  const fan = gui.addFolder('Fan');
  fan.add(tuning.fan, 'restSpacing', 0.004, 0.03, 0.0005).onChange(changed);
  fan.add(tuning.fan, 'passedSpacing', 0.002, 0.02, 0.0005).onChange(changed);
  fan.add(tuning.fan, 'aheadExtra', 0, 0.06, 0.001).onChange(changed);
  fan.add(tuning.fan, 'aheadHalfWidth', 0.5, 8, 0.1).name('fan half-width').onChange(changed);
  fan.add(tuning.fan, 'focusGap', 0, 0.08, 0.001).onChange(changed);
  fan.add(tuning.fan, 'focusLift', 0, 0.3, 0.005).onChange(changed);
  fan.add(tuning.fan, 'focusLean', -30, 30, 0.5).onChange(changed);
  fan.add(tuning.fan, 'restLean', -10, 30, 0.5).onChange(changed);
  fan.add(tuning.fan, 'aheadLean', -10, 40, 0.5).onChange(changed);
  fan.add(tuning.fan, 'passedLean', -40, 10, 0.5).onChange(changed);
  fan.add(tuning.fan, 'sinkDepth', 0, 0.3, 0.005).onChange(changed);
  fan.add(tuning.fan, 'rakePerRecord', 0, 0.04, 0.001).name('riser per record').onChange(changed);
  fan.add(tuning.fan, 'rakeRecords', 1, 20, 0.5).name('riser saturation').onChange(changed);
  fan.add(tuning.fan, 'neighbourFan', 0, 1, 0.05).onChange(changed);

  const crate = gui.addFolder('Crates').close();
  crate.add(tuning.crate, 'riserY', 0, 0.2, 0.005).onChange(changed);
  crate.add(tuning.crate, 'spacing', 0.35, 0.8, 0.01).onChange(changed);
  crate.add(tuning.crate, 'inwardTurn', 0, 30, 0.5).onChange(changed);
  crate.add(tuning.crate, 'neighbourDim', 0, 0.8, 0.01).onChange(changed);
  crate.add(tuning.crate, 'tilt', -10, 15, 0.5).onChange(changed);

  const springs = gui.addFolder('Springs').close();
  springs.add(DEFAULT_FOCUS_TUNING, 'stiffness', 40, 600, 1).name('focus stiffness');
  springs.add(DEFAULT_FOCUS_TUNING, 'damping', 4, 60, 0.5).name('focus damping');
  springs.add(DEFAULT_FOCUS_TUNING, 'friction', 0.5, 12, 0.1).name('scroll friction');
  springs.add(SPRINGS.hover as { stiffness: number }, 'stiffness', 40, 600, 1).name('hover stiffness');

  const cam = gui.addFolder('Camera').close();
  cam.add(tuning.camera, 'pitch', 5, 60, 0.5).onChange(changed);
  cam.add(tuning.camera, 'fov', 20, 70, 0.5).onChange(changed);
  cam.add(tuning.camera, 'height', 1, 2.4, 0.01).onChange(changed);
  cam.add(tuning.camera, 'parallaxYaw', 0, 6, 0.1).onChange(changed);
  cam.add(tuning.camera, 'parallaxPitch', 0, 4, 0.1).onChange(changed);
  cam.add(tuning.camera, 'driftDeg', 0, 2, 0.05).onChange(changed);

  const look = gui.addFolder('Light & post').close();
  const relight = () => setLights({ ...tuning.lights });
  look.add(tuning.lights, 'key', 0, 12, 0.1).onChange(relight);
  look.add(tuning.lights, 'rim', 0, 3, 0.05).onChange(relight);
  look.add(tuning.lights, 'ambient', 0, 1.5, 0.01).onChange(relight);
  look.add(tuning.post, 'bloomIntensity', 0, 3, 0.05).onChange(changed);
  look.add(tuning.post, 'bloomThreshold', 0, 1.5, 0.01).onChange(changed);
  look.add(tuning.post, 'vignette', 0, 0.5, 0.01).onChange(changed);
  look.add(tuning.post, 'grain', 0, 0.1, 0.005).onChange(changed);
  look.add(tuning.post, 'warmth', 0, 0.2, 0.005).onChange(changed);
  look.add(tuning.hold, 'dim', 0, 0.6, 0.01).name('held: room dim').onChange(changed);

  gui
    .add({ copy: () => void navigator.clipboard?.writeText(JSON.stringify(tuning, null, 2)) }, 'copy')
    .name('Copy values as JSON');
}
