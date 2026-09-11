import type { Key } from "./en"

/**
 * the same strings in russian
 *
 * `Record<Key, string>` rather than a loose object: a key that english has and
 * this file does not is a compile error, and a key here that english dropped is
 * one too. product names stay latin - YouTube, TikTok, Pinterest, cookies.
 */
export const ru: Record<Key, string> = {
  "hero.tagline": "скачивайте без лишних хлопот",
  "hero.cookieHint": "не качается? попробуйте cookies",
  "hero.footerFree":
    "cliply бесплатный и с открытым кодом. его поддерживает один человек.",
  "hero.footerUseful": "если пригодился,",
  "hero.donate": "угостите его кофе",
  "hero.updateCheckFailed": "проверка не удалась",
  "hero.updateCheckFailedBody": "не удалось проверить обновления",

  "menu.about": "о приложении",
  "menu.update": "обновить",
  "menu.donate": "поддержать",
  "menu.github": "github",

  "url.placeholder": "вставьте ссылку на видео...",
  "url.youtubePlaceholder": "вставьте ссылку на видео или плейлист...",
  "url.replacePlaceholder": "вставьте другую ссылку...",
  "url.loading": "\u{1F40B} получаем информацию о видео",
  "url.loaded": "информация о видео загружена",
  "url.selectFolder": "выбрать папку",
  "url.pickerBusy": "дождитесь обработки текущей ссылки",
  "url.youtubeHelper": "поддерживаются видео, shorts и ",
  "url.youtubeHelperPlaylists": "плейлисты",
  "url.youtubeHelperRest": " с youtube.com и youtu.be",
  "url.pinterestHelper":
    "поддерживаются ссылки pin.it и pinterest.com/pin, любой домен страны",
  "url.tiktokHelper":
    "поддерживаются ссылки tiktok.com/@user/video/ID, vm.tiktok.com и vt.tiktok.com",

  "playlist.loaded": "плейлист загружен",
  "playlist.infoFailed": "не удалось получить информацию о плейлисте",

  // «видео» does not decline, so its three forms are the same word. they are
  // spelled out anyway, so every counted sentence here reads the same way and
  // nobody has to work out which ones were shortcuts
  "playlist.videoCount": "{n} видео|{n} видео|{n} видео",
  "playlist.showingFirst": "показаны первые {listed} из {count} видео",
  "playlist.totalHours": "всего {hours} ч {minutes} мин",
  "playlist.totalMinutes": "всего {minutes} мин",

  "playlist.selectAll": "выбрать все",
  "playlist.selectNone": "снять все",
  // russian puts the verb first, which is the reason the count line is one key
  // rather than a number with words glued around it
  "playlist.selectedCount": "выбрано {n} из {total}",
  "playlist.perVideoStatus": "статус по видео",
  "playlist.badgeDone": "готово {n}",
  "playlist.badgeDownloading": "скачивается {n}",

  "playlist.rowSaved": "сохранено",
  "playlist.rowSavedAt": "сохранено · {height}p",
  "playlist.rowReused": "уже скачано",
  "playlist.rowNotSaved": "не сохранено",
  "playlist.rowQueued": "в очереди",
  "playlist.rowStopping": "останавливаем",
  "playlist.rowUnavailable": "недоступно",

  "playlist.tabVideo": "видео",
  "playlist.qualityHeading": "качество",
  "playlist.qualityPlaceholder": "выберите ограничение качества...",
  "playlist.ceilingLabel": "до {limit}",
  "playlist.ceilingHelper":
    "каждое видео сохраняется в MP4 в лучшем качестве до {limit}, с оригинальным звуком.",
  "playlist.videoIntro":
    "одно качество на весь плейлист. видео и звук объединяются автоматически.",
  "playlist.audioIntro": "звук из каждого выбранного видео, в одном формате.",
  "playlist.audioNote":
    "каждое видео сохраняется целиком, в выбранном выше формате.",
  "playlist.pickVideosFirst": "сначала выберите видео",
  "playlist.pickTracksFirst": "сначала выберите дорожки",
  "playlist.downloadVideos":
    "скачать {n} видео|скачать {n} видео|скачать {n} видео",
  "playlist.downloadTracks":
    "скачать {n} дорожку|скачать {n} дорожки|скачать {n} дорожек",

  "playlist.starting": "начинаем скачивание плейлиста...",
  "playlist.videoOf": "видео {current} из {total}",
  "playlist.thisVideo": "это видео",
  "playlist.cancelRemaining": "остановить остальные",
  "playlist.cancelKeepsHint":
    "уже сохранённые видео остаются. следующий запуск их пропустит.",

  "playlist.completed": "плейлист скачан",
  "playlist.finished": "скачивание плейлиста завершено",
  "playlist.cancelled": "скачивание плейлиста отменено",
  "playlist.cancelledToast":
    "уже сохранённые видео остаются. повторный запуск их пропустит.",
  "playlist.cancelledHint":
    "уже сохранённые видео остаются. следующий запуск продолжит с того же места.",
  "playlist.failed": "не удалось скачать плейлист",
  "playlist.summarySaved":
    "сохранено {saved} из {n} видео|сохранено {saved} из {n} видео|сохранено {saved} из {n} видео",
  "playlist.summaryReused": "уже скачано {n}",
  "playlist.summarySkipped": "пропущено {n}",
  "playlist.notSavedOne": "не сохранено: {names}.",
  "playlist.notSavedMany": "не сохранено {n} видео: {names}.",
  "playlist.quotedName": "«{title}»",
  "playlist.andMore": "ещё {n}",
  "playlist.listJoin": "{items} и {last}",
  // english says the same thing for one and for many; russian declines the
  // noun, so it spells all three forms out
  "playlist.retryFailed":
    "повторить {n} загрузку|повторить {n} загрузки|повторить {n} загрузок",
  "playlist.downloadAgain": "скачать всё заново",
  "playlist.pickAgain": "выбрать видео заново",

  "playlist.errorNoPlaylist": "сначала загрузите плейлист.",
  "playlist.errorNoId": "по этой ссылке нет плейлиста, который можно скачать.",
  "playlist.errorNoSelection": "выберите хотя бы одно видео.",
  "playlist.errorBusy": "плейлист уже скачивается.",

  "mixedLink.title": "это видео из плейлиста",
  "mixedLink.videoChoice": "только это видео",
  "mixedLink.videoHint": "то, которое открывает ссылка",
  // "все 1 видео" is what agreement gets you at 1 and 21. naming the scope
  // and then the count sidesteps it: the phrase is the same in all three
  // forms, and the number is a number rather than something to agree with
  "mixedLink.playlistChoice":
    "весь плейлист: {n} видео|весь плейлист: {n} видео|весь плейлист: {n} видео",
  "mixedLink.playlistFirst": "первые {n} видео",
  "mixedLink.playlistHint": "открыть плейлист",

  "error.imageNotVideo": "это изображение, а не видео",
  "error.imageNotVideoDesc": "скачивать можно только видео",
  "error.youtubeUrl": "неверная ссылка на YouTube",
  "error.pinterestUrl": "неверная ссылка на Pinterest",
  "error.tiktokUrl": "неверная ссылка на TikTok",
  "error.unavailable": "это видео недоступно для скачивания",
  "error.infoFailed": "не удалось получить информацию о видео",
  "error.tiktokBlocked": "TikTok заблокировал запрос, попробуйте через минуту",

  "validation.youtubeRequired": "введите ссылку на YouTube",
  "validation.youtubeInvalid": "введите корректную ссылку на YouTube",
  "validation.pinterestRequired": "введите ссылку на Pinterest",
  "validation.pinterestInvalid": "введите корректную ссылку на Pinterest",
  "validation.tiktokRequired": "введите ссылку на TikTok",
  "validation.tiktokInvalid": "введите корректную ссылку на TikTok",

  "theme.toggle": "переключить тему",

  "folder.updated": "папка для загрузок обновлена",
  "folder.updateFailed": "не удалось изменить папку для загрузок",

  // cookies are counted, not the file holding them, and the word stays latin
  // and undeclined - so all three forms are the same one
  "cookies.count": "{n} cookies|{n} cookies|{n} cookies",
  "cookies.title": "cookies для YouTube",
  "cookies.description":
    "YouTube иногда решает, что этот компьютер похож на бота, обычно из-за вашей сети, а не из-за ваших действий. файл с cookies из вашего браузера убеждает его в обратном.",
  "cookies.privacy":
    "вы входите в YouTube в своём браузере, а не в cliply. всё остаётся на этом устройстве, мы ничего никуда не загружаем, и вы можете удалить это в любой момент.",
  "cookies.ytdlpCredit": "это стандартный способ, который рекомендует yt-dlp.",
  "cookies.readGuide": "читать инструкцию",
  "cookies.signedIn": "вы вошли",
  "cookies.howTo": "вот как их импортировать",
  "cookies.stillHere": "ваш файл на месте",
  "cookies.stillHereRest":
    ", он просто перестал работать. ничего не удалено. сделайте свежий экспорт и импортируйте его поверх.",
  "cookies.importedToday": "импортировано сегодня",
  "cookies.importedYesterday": "импортировано вчера",
  "cookies.importedDaysAgo":
    "импортировано {n} день назад|импортировано {n} дня назад|импортировано {n} дней назад",

  "cookies.step1": "установите",
  "cookies.step1or": "(chrome) или",
  "cookies.step1firefox": "(firefox)",
  "cookies.step2": "откройте YouTube в браузере и войдите",
  "cookies.step2note":
    "используйте запасной аккаунт, если он есть. YouTube иногда блокирует аккаунты, замеченные за использованием загрузчиков.",
  "cookies.step3": "в этой же вкладке откройте",
  "cookies.step3note":
    "так вкладка окажется там, где YouTube не выдаёт новые cookies.",
  "cookies.copyHint": "нажмите, чтобы скопировать",
  "cookies.copied": "скопировано, вставьте туда",
  "cookies.step4": "нажмите на значок расширения и выберите",
  "cookies.step4export": "export",
  "cookies.step4note":
    "он рядом с адресной строкой, иногда под значком пазла. сохранит .txt в папку загрузок.",
  "cookies.step5": "закройте эту вкладку YouTube",
  "cookies.step5note":
    "YouTube обновляет cookies в открытых вкладках, и каждое обновление старит ваш экспорт. именно закрытая вкладка продлевает им жизнь.",
  "cookies.step6": "импортируйте этот файл здесь",

  "cookies.importing": "импортируем…",
  "cookies.replace": "заменить…",
  "cookies.tryAgain": "ещё раз…",
  "cookies.import": "импортировать cookies…",
  "cookies.testing": "проверяем…",
  "cookies.test": "проверить",
  "cookies.remove": "удалить",

  "cookies.footerSignedIn":
    "YouTube со временем их меняет. когда это случится, cliply скажет об этом прямо здесь.",
  "cookies.footer":
    "ничего отсюда никуда не отправляется. файл уходит только в YouTube и только с вашего компьютера.",

  "cookies.imported": "cookies импортированы",
  "cookies.importedDesc": "теперь YouTube будет считать, что вы вошли.",
  "cookies.notSignedIn": "импортировано, но вход не выполнен",
  "cookies.notSignedInDesc": "с этими cookies вход не выполняется.",
  "cookies.importFailed": "не удалось импортировать этот файл",
  "cookies.importFailedDesc": "не удалось импортировать cookies",
  "cookies.turnedDown": "YouTube их не принял",
  "cookies.lookFine": "с cookies всё в порядке",
  "cookies.notUsable": "cookies не подходят",
  "cookies.testFailed": "не удалось проверить cookies",
  "cookies.removeFailed": "не удалось удалить cookies",
  "cookies.removeFailedDesc": "они всё ещё на этом компьютере.",
  "cookies.copyFailed": "не удалось скопировать",
  "cookies.copyFailedDesc":
    "введите youtube.com/robots.txt в этой вкладке вручную.",

  "toast.overwhelmed": "мы перегружены",
  "toast.openFolder": "открыть папку",
  "toast.report": "сообщить",
  "toast.fixWithCookies": "исправить через cookies",
  "toast.botCookies": "обычно помогает вход через запасной аккаунт.",
  "toast.botGeneric": "сайт просит подтвердить, что мы не боты.",
  "toast.audioDone": "аудио скачано",
  "toast.videoDone": "видео скачано",
  "toast.audioDoneDesc": "аудиофайл сохранён на ваше устройство.",
  "toast.videoDoneDesc": "видеофайл сохранён на ваше устройство.",

  "download.startingAudio": "начинаем скачивание аудио...",
  "download.startingVideo": "начинаем скачивание видео...",
  "download.audioProgress": "скачиваем аудио... {percent}%",
  "download.videoProgress": "скачиваем видео... {percent}%",
  "download.audioCompleted": "аудио скачано",
  "download.videoCompleted": "видео скачано",
  "download.saved": "сохранено: {filename}",
  "download.audioFailed": "не удалось скачать аудио",
  "download.videoFailed": "не удалось скачать видео",
  "download.failed": "не удалось скачать",
  "download.wentWrong":
    "что-то пошло не так. вы можете отправить нам подробности.",
  "download.startFailed": "не удалось начать скачивание: {message}",
  "download.cancelled": "скачивание отменено",
  "download.audioCancelled": "скачивание аудио отменено",
  "download.videoCancelled": "скачивание видео отменено",
  "download.complete": "скачивание завершено",
  "download.video": "скачать видео",
  "download.audio": "скачать аудио",
  "download.inProgress": "скачивание...",
  "download.mergeHint": "видео и аудио объединятся автоматически",
  "download.audioHint": "аудио будет скачано в выбранном формате и диапазоне",

  "card.tabVideo": "видео",
  "card.tabAudio": "только аудио",
  "card.videoIntro": "скачивание видео с подходящей аудиодорожкой",
  "card.audioIntro": "извлечение аудио из видео в выбранном диапазоне",
  "card.summary": "параметры загрузки",
  "card.uploader": "автор:",
  "card.duration": "длительность:",
  "card.size": "размер:",
  "card.format": "формат:",
  "card.language": "язык:",
  "card.timeRange": "диапазон:",
  // the row sits beside a video icon and a "1080p MP4" value, so the noun the
  // english label repeats is not needed to read it
  "card.videoQuality": "качество:",
  "card.audioTrack": "дорожка:",
  "card.bestAvailable": "лучшая доступная",
  "card.preciseCut": "точная обрезка:",
  "card.enabled": "включено",
  "card.disabled": "выключено",
  "card.preciseCutHint":
    "выключите для быстрой загрузки, но обрезка будет менее точной",
  "card.pinterestSubtitle": "лучшее доступное качество, файл MP4.",
  "card.tiktokSubtitle":
    "лучшее доступное качество, файл MP4. без водяного знака.",

  "dropdown.videoQuality": "качество видео",
  "dropdown.videoQualityPlaceholder": "выберите качество...",
  "dropdown.audioFormat": "формат аудио",
  "dropdown.audioFormatPlaceholder": "выберите формат...",
  "dropdown.audioLanguage": "язык дорожки",
  "dropdown.audioLanguagePlaceholder": "выберите язык дорожки...",
  "dropdown.selected": "выбрано:",
  "dropdown.plusBestAudio": "+ лучшее аудио",
  "dropdown.original": "оригинал",
  "dropdown.noVideoStreams":
    "по этой ссылке нет видео, только аудио. вкладка «только аудио» всё равно работает.",

  "format.mp3": "MP3",
  "format.m4a": "M4A",
  "format.mp3Detail": "с конвертацией · играет везде",
  "format.m4aDetail": "AAC · с конвертацией",
  // "source quality" is what the row's own label already says, and the detail
  // shares a line with it - so the russian drops it rather than wrap
  "format.originalDetail": "без перекодирования · обычно WEBM/Opus",

  "time.selection": "выбор диапазона",
  "time.range": "диапазон времени",
  "time.start": "начало",
  "time.end": "конец",
  "time.selectedDuration": "длительность:",
  "time.helper": "формат MM:SS или HH:MM:SS. максимум: {max}",
  "time.helperShort": "формат: MM:SS или HH:MM:SS • максимум: {max}",
  "time.invalid": "неверный диапазон",
  "time.startNegative": "начало не может быть отрицательным",
  "time.endExceeds": "конец выходит за длительность видео",
  "time.endBeforeStart": "конец должен быть позже начала",

  "media.video": "видео",
  "media.audio": "аудио",
  "progress.downloading": "скачивание {label}",
  "progress.processing": "обработка {label}",
  "progress.startingUp": "запускаем",
  "progress.trimming": "при обрезке прогресс не показывается",
  "progress.stop": "стоп",
  "progress.stopTitle": "остановить загрузку",
  "progress.working": "идёт работа",

  "feedback.title": "помогите улучшить",
  "feedback.subtitle": "предложите функцию",
  "feedback.cta": "жмите :)",

  "layout.downloadsAt": "загрузки сохраняются в",
  "layout.concurrentNote":
    "можно качать несколько файлов сразу, скорость при этом может падать.",

  "thumb.unavailable": "превью недоступно",
  "thumb.viewOn": "открыть в {name}",
  "thumb.openFailed": "не удалось открыть ссылку {name}",
  "player.cantDisplay": "не удаётся показать видео",

  "update.available": "доступно обновление",
  "update.macManual": "версию {version} на Mac нужно скачать вручную",
  "update.download": "скачать",
  "update.downloadingTitle": "обновление скачивается",
  "update.autoDownloading": "версия {version} скачивается в фоне автоматически",
  "update.readyToDownload": "версия {version} готова к скачиванию",
  "update.upToDate": "у вас последняя версия",
  "update.upToDateDesc": "новее пока нет",
  "update.progress": "скачиваем обновление: {percent}%",
  "update.inBackground": "скачиваем в фоне...",
  "update.readyToInstallToast": "обновление готово к установке",
  "update.downloadedDesc":
    "версия {version} скачана. она установится, когда вы закроете приложение.",
  "update.installNow": "установить",
  "update.checking": "проверяем обновления...",
  "update.error": "ошибка обновления",
  "update.preparing": "готовим скачивание...",
  "update.preparingDesc": "запускаем скачивание обновления",
  "update.started": "скачивание началось",
  "update.startedDesc":
    "обновление скачивается в фоне. приложением можно пользоваться дальше.",
  "update.downloadFailed": "не удалось скачать",
  "update.downloadFailedDesc": "не удалось скачать обновление",
  "update.checkConnection": "попробуйте ещё раз или проверьте подключение",
  "update.installing": "устанавливаем обновление",
  "update.installingDesc":
    "приложение закроется и откроется уже с новой версией",
  "update.installFailed": "не удалось установить",
  "update.installFailedDesc": "попробуйте скачать обновление ещё раз",

  "update.cardDownloading": "скачиваем обновление",
  "update.cardProgress": "версия {version} • скачано {percent}%",
  "update.cardReady": "обновление готово",
  "update.cardReadyDesc": "версия {version} готова к установке",
  "update.installRestart": "установить и перезапустить",
  "update.tryAgain": "попробовать ещё раз",
  "update.importantUpdates": "проверить важные обновления",

  "update.macDesc":
    "на Mac мы не умеем обновляться сами. нажмите «почему», чтобы узнать больше.",
  "update.newVersion": "доступна новая версия cliply.",
  "update.version": "версия {version}",
  "update.released": "вышла {date}",
  "update.later": "позже",
  "update.learnWhy": "почему",
  "update.downloadFromGithub": "скачать с GitHub",
  "update.downloadUpdate": "скачать обновление",
  "update.readyToInstall": "обновление готово к установке",
  "update.readyToInstallDesc":
    "обновление скачано и готово к установке. приложение перезапустится само.",
  "update.whenReady": "установим, когда вы будете готовы",

  "report.title": "сообщить о проблеме",
  "report.description":
    "откроется заполненный черновик обращения на GitHub в вашем браузере. посмотрите его там и опубликуйте, когда будете готовы.",
  "report.whatWentWrong": "что пошло не так",
  "report.yourSetup": "ваша система, приложим как есть",
  "report.technicalDetails": "технические детали, которые мы приложим",
  "report.show": "показать",
  "report.notes": "что вы делали, когда это случилось?",
  "report.notesPlaceholder": "необязательно, но так мы найдём причину быстрее.",
  // present tense keeps the line the same for everyone: "скачивал" would pick a
  // gender the app has no way of knowing
  "report.includeLink": "приложить ссылку, которую я скачиваю",
  "report.notNow": "не сейчас",
  "report.openOnGithub": "открыть на GitHub",
  "report.opening": "открываем GitHub",
  "report.trimmed":
    "мы обрезали логи, чтобы всё поместилось. полный отчёт скопирован в буфер обмена.",
  "report.reviewIt": "проверьте заполненное обращение и отправьте его.",
  "report.browserFailed": "не удалось открыть браузер",
  "report.browserFailedDesc":
    "полный отчёт в буфере обмена. вставьте его на github.com/Cliply/Cliply/issues/new",

  // english needs no plural here - main's milestones are all well past one -
  // but russian picks a form for every number, so all three are spelled out
  "support.title":
    "это уже {n} загрузка|это уже {n} загрузки|это уже {n} загрузок",
  "support.description":
    "cliply бесплатный, без рекламы и без слежки. его делает и поддерживает один человек в свободное время, в основном вопреки тому, что YouTube нарочно всё меняет.",
  "support.ask": "если он сэкономил вам время, кофе поможет.",
  "support.decline": "нет, спасибо"
}

/**
 * main's error wording, in russian, keyed by the taxonomy category it carries
 *
 * main stays english on purpose - its sentences feed logs, analytics and issue
 * bodies that maintainers read - so the translation is an overlay here, applied
 * only to the toast the user reads. one entry per key of `ERROR_METADATA` and
 * `TERMINAL_ERRORS` in `src/main/services/ytdlp-engine.js`; a category with no
 * entry keeps main's english, which is the right failure mode for a code this
 * file has not caught up with yet.
 *
 * a few entries are keyed by a `wordingCode` instead, for the failures main
 * words more precisely than their category does. `RECORDS_UNWRITABLE` is one:
 * it is a PERMISSION_ERROR, and the permission entry below tells the reader to
 * choose another download folder, which does nothing about a folder inside
 * cliply's own app data.
 */
export const ruErrors: Partial<
  Record<string, { message: string; suggestion: string }>
> = {
  BOT_DETECTION: {
    message: "YouTube просит подтвердить, что вы не бот.",
    suggestion: "импортируйте cookies YouTube в настройках и попробуйте снова."
  },
  VIDEO_UNAVAILABLE: {
    message: "это видео недоступно для скачивания.",
    suggestion:
      "возможно, оно приватное, с возрастным ограничением или удалено."
  },
  NOT_A_VIDEO: {
    message: "по этой ссылке нет видео.",
    suggestion: "cliply скачивает видео, попробуйте ссылку, где оно есть."
  },
  GEO_BLOCKED: {
    message: "это видео недоступно в вашей стране.",
    suggestion: "автор ограничил, где его можно смотреть."
  },
  EXTRACTION_FAILED: {
    message: "YouTube что-то изменил, и загрузчику нужно это догнать.",
    suggestion: "обычно помогает обновление загрузчика."
  },
  NETWORK_ERROR: {
    message: "сеть прервала скачивание.",
    suggestion: "проверьте подключение и попробуйте снова."
  },
  RATE_LIMITED: {
    message: "YouTube временно ограничивает это устройство.",
    suggestion: "подождите несколько минут перед следующей попыткой."
  },
  DISK_FULL: {
    message: "на диске не хватает места для этой загрузки.",
    suggestion: "освободите место и попробуйте снова."
  },
  PERMISSION_ERROR: {
    message: "не получается записать в папку загрузок.",
    suggestion: "проверьте права доступа или выберите другую папку."
  },
  // the same category, a different folder: this one is cliply's own, and no
  // choice the user makes about the download folder touches it
  RECORDS_UNWRITABLE: {
    message: "cliply не смог подготовить запись об этой загрузке.",
    suggestion:
      "проверьте права доступа к папке с данными cliply и попробуйте снова."
  },
  PATH_ERROR: {
    message: "не удалось записать по этому пути.",
    suggestion: "выберите другую папку для загрузок или путь покороче."
  },
  JS_RUNTIME_MISSING: {
    message: "не хватает компонента, который нужен загрузчику.",
    suggestion: "переустановите cliply."
  },
  FFMPEG_MISSING: {
    message: "видеообработчик отсутствует.",
    suggestion: "переустановите cliply."
  },
  FFMPEG_AV_BLOCKED: {
    message: "антивирус остановил видеообработчик.",
    suggestion: "разрешите cliply в антивирусе и попробуйте снова."
  },
  FFMPEG_CORRUPT_STREAM: {
    message: "видеопоток оказался повреждён.",
    suggestion: "попробуйте другое качество."
  },
  FFMPEG_ERROR: {
    message: "что-то пошло не так при обработке видео.",
    suggestion: "попробуйте ещё раз."
  },
  CANCELLED: {
    message: "скачивание отменено.",
    suggestion: "начните его заново, когда будете готовы."
  },
  STALLED: {
    message: "скачивание перестало отвечать.",
    suggestion: "проверьте подключение и попробуйте снова."
  },
  ENGINE_MISSING: {
    message: "движок загрузчика отсутствует.",
    suggestion:
      "перезапустите cliply, а если это повторяется, переустановите его."
  },
  DOWNLOAD_FAILED: {
    message: "не удалось скачать.",
    suggestion: "попробуйте ещё раз."
  }
}

/**
 * main's cookie sentences, in russian, keyed by the stable code beside them
 *
 * the same overlay as `ruErrors`, for the three places main words a cookie
 * verdict: the import refusals thrown by `cookie-manager.js`, the jar problems
 * (`JAR_*`) and the probe notes (`PROBE_*`) composed in `ipc-handlers.js`.
 *
 * two of main's notes interpolate a value - the probe's own error text, and how
 * many test videos were down - and the code arrives without it. Both say
 * nothing a russian reader can act on, so the translation drops them rather
 * than widening the ipc payload to carry them across.
 */
export const ruCodes: Partial<Record<string, string>> = {
  COOKIES_FILE_EMPTY: "этот файл пустой.",
  COOKIES_MALFORMED:
    "этот файл с cookies испорчен. колонка домена расходится с собственным флагом поддомена, поэтому yt-dlp отвергает его целиком. сделайте свежий экспорт вместо правки вручную.",
  COOKIES_EMPTY:
    "в этом файле нет cookies. экспортируйте cookies.txt расширением и выберите именно его.",
  COOKIES_NOT_YOUTUBE:
    "в файле есть cookies, но ни одного от YouTube. экспортируйте cookies.txt, находясь на youtube.com.",
  COOKIES_TOO_BIG:
    "этот файл слишком большой для экспорта cookies. выберите cookies.txt, который сохранило расширение.",
  COOKIES_JSON:
    "это json, а не cookies.txt в формате netscape. экспортируйте именно cookies.txt.",

  JAR_MALFORMED: "файл испорчен, сделайте свежий экспорт вместо правки вручную",
  JAR_NOT_COOKIE_FILE: "это не файл cookies.txt, экспортируйте его заново",
  JAR_NOTHING_IMPORTED: "пока ничего не импортировано",
  JAR_NO_YOUTUBE: "в файле нет cookies от YouTube",
  JAR_EXPIRED: "ваши cookies истекли, сделайте свежий экспорт",
  JAR_SESSION_ENDED:
    "YouTube завершил эту сессию, экспортируйте cookies заново",
  JAR_NEVER_SIGNED_IN:
    "эти cookies не из сессии со входом, сначала войдите, потом экспортируйте",
  JAR_UNUSABLE: "нет пригодных cookies от YouTube",

  PROBE_PASSED:
    "скачивание сработало с вашими cookies. само по себе это не доказывает, что YouTube их принял.",
  PROBE_EMPTY: "тестовое видео вернулось пустым.",
  PROBE_REJECTED:
    "YouTube всё равно просит подтвердить, что мы не боты, хотя ваши cookies отправлены, значит они истекли или не принимаются.",
  PROBE_UNREACHABLE:
    "не удалось связаться с YouTube, поэтому cookies остались непроверенными.",
  PROBE_FAILED: "тест не удалось завершить.",
  PROBE_TARGETS_DOWN:
    "все наши тестовые видео сейчас недоступны, так что это ничего не говорит о ваших cookies."
}
