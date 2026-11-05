// Adapted from LosslessCut; see third-party/losslesscut/README.md and LICENSE.
const enableLog = false, encode = true;
const getHwaccelArgs = hwaccel => hwaccel !== 'none' ? ['-hwaccel', hwaccel] : [];
const getFixChannelLayoutFilter = ({ channels, channelLayout }) => channels > 0 && /^\d+ channels \(/.test(channelLayout || '') ? 'channelmap=' + Array.from({ length: channels }, (_, i) => i).join('|') : undefined;
function compatibilityArgs({ path, videoStreamIndex, audioStreams, seekTo, size, fps, rotate, forceColorspace, ffmpegHwaccel }) {
    function getFilters() {
        const graph = [];
        if (videoStreamIndex != null) {
            const videoFilters = [];
            // we need to reduce the color space to bt709 for compatibility with most OS'es and hardware combinations
            // especially because of this bug https://github.com/electron/electron/issues/47947
            // see also https://www.reddit.com/r/ffmpeg/comments/jlk2zn/how_to_encode_using_bt709/
            const getScaleFilter = () => {
                const scaleFilterOptions = [];
                if (size != null)
                    scaleFilterOptions.push(`${size}:${size}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2`);
                scaleFilterOptions.push('in_color_matrix=auto:in_range=auto:out_color_matrix=bt709:out_range=tv');
                if (scaleFilterOptions.length === 0)
                    return [];
                return [
                    // scale down first to reduce processing load
                    `scale=${scaleFilterOptions.join(':')}`,
                    'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709',
                    // 'setparams=auto:tv:bt709:bt709:bt709:auto',
                ];
            };
            videoFilters.push(
            // Not sure but I think fps filter should be first to discard unneeded frames early (for performance)
            ...(fps != null ? [`fps=${fps}`] : []),
            // When dealing with certain PRORES 10 bit files, possibly due to invaid color space info (example fixture clipcanvas_14348_PRORES_HQ-every-frame-keyframe.mov)
            // we need to ensure a correct colorspace first, or else the scale filter could fail with e.g.:
            // [swscaler @ 0x999fb8000] Unsupported input (Operation not supported): fmt:yuv422p10le csp:bt709 prim:reserved trc:reserved -> fmt:yuv420p csp:bt709 prim:reserved trc:reserved
            // https://www.reddit.com/r/ffmpeg/comments/1noakxm/swscaler_says_unsupported_input/
            // https://www.reddit.com/r/ffmpeg/comments/1pfme4p/swscaler_unsupported_input_again/
            // https://www.reddit.com/r/ffmpeg/comments/1j7k3vg/colorspace_issues_when_extracting_frames/
            ...(forceColorspace ? ['colorspace=iall=bt709:all=bt709'] : []),
            // After much testing, swscaler (scale filter) seems to be the fastest way to convert color spaces
            ...getScaleFilter(),
            // We could also have used zscale, but it needs ffmpeg built with zimg library and `--enable-libzimg`, *and* it seems slower than swscaler:
            // 'zscale=matrix=bt709:primaries=bt709:transfer=bt709,format=yuv420p',
            // scaling down first makes it slightly faster but it's still slower than swscaler:
            // `zscale=w=min((iw/ih)*${size}\\,${size}):h=-2:matrix=bt709:primaries=bt709:transfer=bt709,format=yuv420p`,
            // and zscale *also* fails if input color parameters are invalid:
            // zscale code 3074: no path between colorspaces
            // https://www.reddit.com/r/ffmpeg/comments/1j97o3q/yet_another_no_path_between_colorspaces_problem/
            // this filter even if input color parameters are invalid, but it forces input to be interpreted as bt709:
            // 'zscale=matrixin=bt709:primariesin=bt709:transferin=bt709:matrix=bt709:primaries=bt709:transfer=bt709',
            // we could also have used `tonemap=hable` but it's also slow:
            // 'tonemap=hable',
            // https://gist.github.com/goyuix/033d35846b05733d77f568b754e7c3ea
            // https://superuser.com/questions/1732301/convert-10bit-hdr-video-to-8bit-frames/1732684#1732684
            // finally, convert to most compatible pixel format:
            'format=yuv420p');
            const videoFiltersStr = videoFilters.length > 0 ? videoFilters.join(',') : 'null';
            graph.push(`[0:${videoStreamIndex}]${videoFiltersStr}[video]`);
        }
        if (audioStreams.length > 0) {
            // some streams have a channel layout that ffmpeg cannot resample or downmix, so relabel it first
            const getAudioFilters = (stream, rest) => {
                const filters = [getFixChannelLayoutFilter(stream), ...rest].filter((filter) => filter != null);
                return filters.length > 0 ? filters.join(',') : 'anull';
            };
            if (audioStreams.length > 1) {
                const resampledStr = audioStreams.map(({ index }) => `[resampled${index}]`).join('');
                const weightsStr = audioStreams.map(() => '1').join(' ');
                graph.push(
                // First resample because else we get the lowest sample rate
                ...audioStreams.map((stream) => `[0:${stream.index}]${getAudioFilters(stream, ['aresample=44100'])}[resampled${stream.index}]`),
                // now mix all audio channels together
                `${resampledStr}amix=inputs=${audioStreams.length}:duration=longest:weights=${weightsStr}:normalize=0:dropout_transition=2[audio]`);
            }
            else {
                graph.push(`[0:${audioStreams[0].index}]${getAudioFilters(audioStreams[0], [])}[audio]`);
            }
        }
        if (graph.length === 0)
            return [];
        return ['-filter_complex', graph.join(';')];
    }
    const videoEncodeArgs = [
        'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '10',
    ];
    // const videoEncodeArgs = ['h264_videotoolbox', '-b:v', '5M']
    const args = [
        '-hide_banner',
        ...(enableLog ? [] : ['-loglevel', 'error']),
        ...getHwaccelArgs(ffmpegHwaccel),
        // https://stackoverflow.com/questions/16658873/how-to-minimize-the-delay-in-a-live-streaming-with-ffmpeg
        // https://unix.stackexchange.com/questions/25372/turn-off-buffering-in-pipe
        // https://stackoverflow.com/questions/30868854/flush-latency-issue-with-fragmented-mp4-creation-in-ffmpeg
        '-fflags', '+nobuffer+flush_packets+discardcorrupt',
        '-avioflags', 'direct',
        // '-flags', 'low_delay', // this seems to ironically give a *higher* delay
        '-flush_packets', '1',
        '-ss', String(seekTo),
        ...(rotate != null ? [
            '-display_rotation', '0',
            '-noautorotate',
        ] : []),
        '-i', path,
        '-fps_mode', 'passthrough',
        '-map_metadata', '-1',
        '-map_chapters', '-1',
        ...(encode ? [
            ...getFilters(),
            ...(videoStreamIndex != null ? [
                '-map', '[video]',
                '-c:v', ...videoEncodeArgs,
                '-g', '1', // reduces latency and buffering
            ] : ['-vn']),
            ...(audioStreams.length > 0 ? [
                '-map', '[audio]',
                '-ac', '2', '-c:a', 'aac', '-b:a', '128k',
            ] : ['-an']),
            // May alternatively use webm/vp8 https://stackoverflow.com/questions/24152810/encoding-ffmpeg-to-mpeg-dash-or-webm-with-keyframe-clusters-for-mediasource
        ] : [
            '-c', 'copy',
        ]),
        '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-',
    ];
    return args;
}
module.exports = { compatibilityArgs };
