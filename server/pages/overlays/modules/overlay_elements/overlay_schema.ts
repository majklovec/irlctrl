/*
 * Schema manifest of the built-in overlay elements (environment-free:
 * shared by the control server's scene validator and the browser editor).
 * Every element's props contract, defaults and normalization live with the
 * element itself in elements/<name>.schema.ts (rendering + inspector next
 * to it in elements/<name>.tsx); this file only aggregates them so the
 * module keeps its `overlay_schema.ts` entry point
 * (generated/overlay_schemas.ts, scripts/gen_modules.ts).
 */
import type { OverlayElementSchema } from "../../../../core/overlay_element";

export { alertSchema } from "./elements/alerts_schema";
export { chatSchema } from "./elements/chat_schema";
export { countdownSchema } from "./elements/countdown_schema";
export { counterSchema } from "./elements/counter_schema";
export { creditsSchema } from "./elements/credits_schema";
export { ellipseSchema } from "./elements/ellipse_schema";
export { emoteComboSchema } from "./elements/emote_combo_schema";
export { emoteWallSchema } from "./elements/emote_wall_schema";
export { featuredSchema } from "./elements/featured_schema";
export { frameSchema } from "./elements/frame_schema";
export { goalSchema } from "./elements/goal_schema";
export { groupSchema } from "./elements/group_schema";
export { iframeSchema } from "./elements/iframe_schema";
export { imageSchema } from "./elements/image_schema";
export { lineSchema } from "./elements/line_schema";
export { lowerThirdSchema } from "./elements/lower_third_schema";
export { nowPlayingSchema } from "./elements/now_playing_schema";
export { progressSchema } from "./elements/progress_schema";
export { rectangleSchema } from "./elements/rectangle_schema";
export { socialsSchema } from "./elements/socials_schema";
export { spinWheelSchema } from "./elements/spin_wheel_schema";
export { tasksSchema } from "./elements/tasks_schema";
export { textSchema } from "./elements/text_schema";
export { videoSchema } from "./elements/video_schema";
export { weatherSchema } from "./elements/weather_schema";

import { alertSchema } from "./elements/alerts_schema";
import { chatSchema } from "./elements/chat_schema";
import { countdownSchema } from "./elements/countdown_schema";
import { counterSchema } from "./elements/counter_schema";
import { creditsSchema } from "./elements/credits_schema";
import { ellipseSchema } from "./elements/ellipse_schema";
import { emoteComboSchema } from "./elements/emote_combo_schema";
import { emoteWallSchema } from "./elements/emote_wall_schema";
import { featuredSchema } from "./elements/featured_schema";
import { frameSchema } from "./elements/frame_schema";
import { goalSchema } from "./elements/goal_schema";
import { groupSchema } from "./elements/group_schema";
import { iframeSchema } from "./elements/iframe_schema";
import { imageSchema } from "./elements/image_schema";
import { lineSchema } from "./elements/line_schema";
import { lowerThirdSchema } from "./elements/lower_third_schema";
import { nowPlayingSchema } from "./elements/now_playing_schema";
import { progressSchema } from "./elements/progress_schema";
import { rectangleSchema } from "./elements/rectangle_schema";
import { socialsSchema } from "./elements/socials_schema";
import { spinWheelSchema } from "./elements/spin_wheel_schema";
import { tasksSchema } from "./elements/tasks_schema";
import { textSchema } from "./elements/text_schema";
import { videoSchema } from "./elements/video_schema";
import { weatherSchema } from "./elements/weather_schema";

export default [
    textSchema,
    imageSchema,
    videoSchema,
    rectangleSchema,
    ellipseSchema,
    lineSchema,
    progressSchema,
    iframeSchema,
    groupSchema,
    alertSchema,
    weatherSchema,
    nowPlayingSchema,
    countdownSchema,
    lowerThirdSchema,
    frameSchema,
    socialsSchema,
    creditsSchema,
    tasksSchema,
    goalSchema,
    counterSchema,
    spinWheelSchema,
    emoteWallSchema,
    emoteComboSchema,
    featuredSchema,
    chatSchema,
] satisfies OverlayElementSchema[];
