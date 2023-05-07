import { getPlaybackFormats } from "./thumbnailData";
import { getFromCache, RenderedThumbnailVideo, setupCache } from "./thumbnailDataCache";
import { VideoID } from "@ajayyy/maze-utils/lib/video";
import { getVideoThumbnailIncludingUnsubmitted } from "../dataFetching";
import { log, logError } from "../utils/logger";

export async function renderThumbnail(videoID: VideoID, width: number,
    height: number, saveVideo: boolean, timestamp: number): Promise<RenderedThumbnailVideo | null> {
    const start = Date.now();

    const existingCache = getFromCache(videoID);
    let reusedVideo: HTMLVideoElement | null = null;
    if (existingCache && existingCache?.video?.length > 0) {
        const bestVideos = ((width && height) ? existingCache.video.filter(v => v.width >= width && v.height >= height)
            : existingCache.video).sort((a, b) => b.width - a.width);

        const sameTimestamp = bestVideos.sort((a, b) => b.width - a.width).find(v => v.timestamp === timestamp);

        if (sameTimestamp?.rendered) {
            return sameTimestamp;
        } else if (sameTimestamp) {
            return new Promise((resolve) => {
                sameTimestamp.onReady.push((a) => {
                    resolve(a)
                });
            });
        } else if (bestVideos.length > 0) {
            reusedVideo = bestVideos[0].video;
        }
    }

    let format = await getPlaybackFormats(videoID, width, height);
    if (!format) return null; //todo: handle null url, example: byXHW0dvu2U

    let video = createVideo(reusedVideo, format.url, timestamp);

    let tries = 1;
    const videoCache = setupCache(videoID);
    videoCache.video.push({
        video: video,
        width: format.width,
        height: format.height,
        rendered: false,
        onReady: [],
        timestamp
    });

    return new Promise((resolve, reject) => {
        let resolved = false;

        const loadedData = () => {
            const betterVideo = getFromCache(videoID)?.video?.find(v => v.width >= width && v.height >= height
                && v.timestamp === timestamp && v.rendered);
            if (betterVideo) {
                video.remove();
                resolved = true;

                reject("Already rendered");
                return;
            }

            log(videoID, "videoLoaded", video.currentTime, video.readyState, video.seeking)
            if (video.readyState < 2 || video.seeking) {
                setTimeout(loadedData, 50);
                return;
            }
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext("2d")?.drawImage(video, 0, 0);

            const videoInfo: RenderedThumbnailVideo = {
                canvas,
                video: saveVideo ? video : null,
                width: video.videoWidth,
                height: video.videoHeight,
                rendered: true,
                onReady: [],
                timestamp
            };

            const videoCache = setupCache(videoID);
            const currentVideoInfoIndex = videoCache.video.findIndex(v => v.width === video.videoWidth
                && v.height === video.videoHeight && v.timestamp === timestamp);
            const currentVideoInfo = currentVideoInfoIndex !== -1 ? videoCache.video[currentVideoInfoIndex] : null;
            if (currentVideoInfo) {
                for (const callback of currentVideoInfo.onReady) {
                    callback(videoInfo);
                }

                videoCache.video[currentVideoInfoIndex] = videoInfo;
            } else {
                videoCache.video.push(videoInfo);
            }

            log(videoID, (Date.now() - start) / 1000, width > 0 ? "full" : "smaller");

            if (!saveVideo) {
                video.src = "";
                video.remove();
            } else {
                video.removeEventListener("loadeddata", loadedData);
                video.removeEventListener("seeked", loadedData)
                video.removeEventListener("error", errorHandler);
            }

            resolved = true;
            resolve(videoInfo);
        };

        const errorHandler = () => void (async () => {
            if (!resolved) {
                // Try creating the video again
                video.remove();

                if (tries++ > 5) {
                    // Give up
                    const videoCache = getFromCache(videoID);
                    if (videoCache?.video) {
                        videoCache.video = videoCache.video.filter(v => v.width !== width && v.height !== height && v.timestamp !== timestamp);
                    }

                    console.error(`Failed to render thumbnail for ${videoID} after ${tries} tries`);
                    reject("Failed to render thumbnail");
                    return;
                }

                format = await getPlaybackFormats(videoID, width, height, true);
                if (format === null) {
                    resolve(null);
                    return;
                }

                const videoCache = setupCache(videoID);
                const index = videoCache.video.findIndex(v => v.width === format?.width 
                    && v.height === format?.height && v.timestamp === timestamp);
                if (index !== -1) {
                    videoCache.video[index].video = video;
                } else {
                    videoCache.video.push({
                        video: video,
                        width: format?.width,
                        height: format?.height,
                        rendered: false,
                        onReady: [],
                        timestamp
                    });
                }

                video = createVideo(null, format?.url, timestamp);
                video.addEventListener("loadeddata", loadedData);
                video.addEventListener("error", errorHandler);
            }
        })();

        video.addEventListener("error", errorHandler);
        if (reusedVideo) {
            video.addEventListener("seeked", loadedData);
        } else {
            video.addEventListener("loadeddata", loadedData);
        }
    })
}

/**
 * Returns a canvas that will be drawn to once the thumbnail is ready.
 * 
 * Starts with lower resolution and replaces it with higher resolution when ready.
 */
export async function createThumbnailCanvas(existingCanvas: HTMLCanvasElement | null, videoID: VideoID, width: number,
    height: number, forcedTimestamp: number | null, saveVideo: boolean, ready: (canvas: HTMLCanvasElement) => unknown): Promise<HTMLCanvasElement | null> {
    const urls = await getPlaybackFormats(videoID, width, height);
    if (!urls) return null;

    let timestamp = forcedTimestamp as number;
    if (timestamp === null) {
        try {
            const thumbnail = await getVideoThumbnailIncludingUnsubmitted(videoID, false);
            if (thumbnail && !thumbnail.original) {
                timestamp = thumbnail.timestamp;
            } else {
                // Original thumbnail will be shown automatically
                return null;
            }
        } catch (e) {
            return null;
        }
    }

    const canvas = existingCanvas ?? document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.style.display = "none";

    const result = (canvasInfo: RenderedThumbnailVideo | null) => {
        if (!canvasInfo) return;

        drawCentered(canvas, width, height, canvasInfo.width, canvasInfo.height, canvasInfo.canvas);
        ready(canvas);
    }

    renderThumbnail(videoID, width, height, saveVideo, timestamp).then(result).catch(() => {
        // Try again with lower resolution
        renderThumbnail(videoID, 0, 0, saveVideo, timestamp).then(result).catch(() => {
            logError(`Failed to render thumbnail for ${videoID}`);
        });
    });

    return canvas;
}

export function drawCentered(canvas: HTMLCanvasElement, width: number, height: number,
    originalWidth: number, originalHeight: number, originalSurface: HTMLVideoElement | HTMLCanvasElement): void {
    const calculateWidth = height * originalWidth / originalHeight;
    canvas.getContext("2d")?.drawImage(originalSurface, (width - calculateWidth) / 2, 0, calculateWidth, height);
}

function createVideo(existingVideo: HTMLVideoElement | null, url: string, timestamp: number): HTMLVideoElement {
    const video = existingVideo ?? document.createElement("video");
    // https://stackoverflow.com/a/69074004
    if (!existingVideo) video.src = `${url}#t=${timestamp}-${timestamp + 0.001}`;
    video.currentTime = timestamp;
    video.controls = false;
    video.pause();
    video.volume = 0;

    return video;
}

export async function replaceThumbnail(element: HTMLElement, videoID: VideoID, showCustomBranding: boolean, timestamp?: number): Promise<boolean> {
    const image = element.querySelector("ytd-thumbnail img") as HTMLImageElement;
    const box = element.querySelector("ytd-thumbnail") as HTMLDivElement;

    if (!showCustomBranding) {
        image.classList.add("cb-visible");
        image.style.removeProperty("display");
        return false;
    }

    if (image && box) {
        const width = box.offsetWidth * window.devicePixelRatio;
        const height = box.offsetHeight * window.devicePixelRatio;

        // TODO: Add option not to hide all thumbnails by default
        image.style.display = "none";
        image.classList.remove("cb-visible");

        // Trigger a fetch to start, and display the original thumbnail if necessary
        getVideoThumbnailIncludingUnsubmitted(videoID, false).then((thumbnail) => {
            if (!thumbnail || thumbnail.original) {
                image.classList.add("cb-visible");
                image.style.removeProperty("display");
            }
        }).catch(logError);

        const existingCanvas = image.parentElement?.querySelector(".cbCustomThumbnailCanvas") as HTMLCanvasElement | null;

        try {
            const thumbnail = await createThumbnailCanvas(existingCanvas, videoID, width, height, timestamp ?? null, false, (thumbnail) => {
                thumbnail!.style.removeProperty("display");
            });
    
            if (!thumbnail) {
                image.classList.add("cb-visible");
                image.style.removeProperty("display");
                return false;
            }

            image.style.display = "none";
            image.classList.remove("cb-visible");
            thumbnail.classList.add("style-scope");
            thumbnail.classList.add("ytd-img-shadow");
            thumbnail.classList.add("cbCustomThumbnailCanvas");
            thumbnail.style.height = "100%";
            image.parentElement?.appendChild(thumbnail);
        } catch (e) {
            logError(e);

            image.classList.add("cb-visible");
            image.style.removeProperty("display");
            return false;
        }
    }

    return !!image;
}