import { Live2DManager } from "../live2d/manager";
import { ExpressionResetController } from "../live2d/expression-reset";
import { MouthSyncController } from "../live2d/mouth-sync";
import { SpeakingMotionController } from "../live2d/speaking-motion";
import { TiltFocusController } from "../live2d/tilt-focus";
import { resolveAsset } from "../../shared/renderer-base";

const canvas = document.getElementById("live2d-canvas") as HTMLCanvasElement | null;
if (!canvas) throw new Error("Canvas #live2d-canvas not found");

let tiltFocus: TiltFocusController | null = null;
let expressionReset: ExpressionResetController | null = null;
let mouthSync: MouthSyncController | null = null;
let speakingMotion: SpeakingMotionController | null = null;
const subscriptions: Array<() => void> = [];

const manager = new Live2DManager({
  canvas,
  width: window.innerWidth,
  height: window.innerHeight,
  modelPath: resolveAsset("models/cyrene/Cyrene.model3.json"),
  maxFps: 15,
  onLoad: () => {
    const model = manager.getModel();
    if (!model) return;

    manager.applyZoom(0.72);
    tiltFocus = new TiltFocusController(canvas, model);
    tiltFocus.focusCenter(true);
    expressionReset = new ExpressionResetController(model);
    mouthSync = new MouthSyncController(model);
    speakingMotion = new SpeakingMotionController(model);

    subscriptions.push(
      window.holoCubicRenderer?.onInput((event) => tiltFocus?.handleInput(event)) ?? (() => {}),
      window.live2dAction?.onPlayAction((target) => { void manager.playAction(target); }) ?? (() => {}),
      window.live2dSpeech?.onPrepare(() => {
        void expressionReset?.resetNow();
        mouthSync?.stop();
        speakingMotion?.stop();
      }) ?? (() => {}),
      window.live2dSpeech?.onMouthStart((payload) => {
        mouthSync?.start(Number(payload.durationMs ?? 0));
        speakingMotion?.start();
      }) ?? (() => {}),
      window.live2dSpeech?.onMouthStop(() => {
        mouthSync?.stop();
        speakingMotion?.stop();
      }) ?? (() => {}),
    );
    window.holoCubicRenderer?.ready();
  },
  onError: (error) => console.error("[HoloCubic] Failed to load renderer model:", error),
});

void manager.init();

window.addEventListener("beforeunload", () => {
  for (const off of subscriptions.splice(0)) off();
  expressionReset?.dispose();
  mouthSync?.dispose();
  speakingMotion?.dispose();
  tiltFocus = null;
  expressionReset = null;
  mouthSync = null;
  speakingMotion = null;
  manager.dispose();
});
