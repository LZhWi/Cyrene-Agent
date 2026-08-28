import { Live2DManager } from "../live2d/manager";
import { ExpressionResetController } from "../live2d/expression-reset";
import { MouthSyncController } from "../live2d/mouth-sync";
import { SpeakingMotionController } from "../live2d/speaking-motion";
import { IdleMotionController } from "../live2d/idle-motion";
import { TiltFocusController } from "../live2d/tilt-focus";
import { DeviceIdleActivityController } from "./device-idle-activity";
import { DeviceNeutralRecoveryController } from "./device-neutral-recovery";
import { resolveAsset } from "../../shared/renderer-base";

const canvas = document.getElementById("live2d-canvas") as HTMLCanvasElement | null;
if (!canvas) throw new Error("Canvas #live2d-canvas not found");

let tiltFocus: TiltFocusController | null = null;
let expressionReset: ExpressionResetController | null = null;
let mouthSync: MouthSyncController | null = null;
let speakingMotion: SpeakingMotionController | null = null;
let idleMotion: IdleMotionController | null = null;
let deviceIdleActivity: DeviceIdleActivityController | null = null;
let neutralRecovery: DeviceNeutralRecoveryController | null = null;
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
    expressionReset = new ExpressionResetController(model, { expressionName: "表情回正" });
    mouthSync = new MouthSyncController(model);
    speakingMotion = new SpeakingMotionController(model);
    neutralRecovery = new DeviceNeutralRecoveryController(model, 1_500);
    idleMotion = new IdleMotionController(model, {
      resetMotionMs: 2_000,
      onMotionEnd: () => {
        neutralRecovery?.start();
        void expressionReset?.resetNow();
      },
    });
    deviceIdleActivity = new DeviceIdleActivityController((idle) => idleMotion?.setUserIdle(idle));
    deviceIdleActivity.start();

    subscriptions.push(
      window.holoCubicRenderer?.onInput((event) => {
        deviceIdleActivity?.recordInput();
        tiltFocus?.handleInput(event);
      }) ?? (() => {}),
      window.cyrene.onPetIdleMotionsChanged((enabled) => idleMotion?.setEnabled(enabled)),
      window.live2dAction?.onPlayAction((target) => { void manager.playAction(target); }) ?? (() => {}),
      window.live2dSpeech?.onPrepare(() => {
        idleMotion?.restartWait();
        void expressionReset?.resetNow();
        mouthSync?.stop();
        speakingMotion?.stop();
      }) ?? (() => {}),
      window.live2dSpeech?.onMouthStart((payload) => {
        idleMotion?.setSuspended(true);
        mouthSync?.start(Number(payload.durationMs ?? 0));
        speakingMotion?.start();
      }) ?? (() => {}),
      window.live2dSpeech?.onMouthStop(() => {
        mouthSync?.stop();
        speakingMotion?.stop();
        idleMotion?.setSuspended(false);
      }) ?? (() => {}),
    );
    window.settings?.getGeneral().then((settings) => {
      idleMotion?.setEnabled(settings?.petIdleMotionsEnabled === true);
    }).catch(() => { /* Settings failure leaves device idle motion disabled. */ });
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
  idleMotion?.dispose();
  deviceIdleActivity?.dispose();
  neutralRecovery?.dispose();
  tiltFocus = null;
  expressionReset = null;
  mouthSync = null;
  speakingMotion = null;
  idleMotion = null;
  deviceIdleActivity = null;
  neutralRecovery = null;
  manager.dispose();
});
