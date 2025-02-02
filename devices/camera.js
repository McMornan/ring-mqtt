import RingPolledDevice from './base-polled-device.js'
import utils from '../lib/utils.js'
import pathToFfmpeg from 'ffmpeg-for-homebridge'
import { Worker } from 'worker_threads'
import { spawn } from 'child_process'

export default class Camera extends RingPolledDevice {
    constructor(deviceInfo) {
        super(deviceInfo, 'camera')

        const savedState = this.getSavedState()

        this.hasBattery1 = this.device.data.hasOwnProperty('battery_voltage') ? true : false
        this.hasBattery2 = this.device.data.hasOwnProperty('battery_voltage_2') ? true : false

        this.data = {
            motion: {
                active_ding: false,
                ding_duration: 180,
                last_ding: 0,
                last_ding_expires: 0,
                last_ding_time: 'none',
                is_person: false,
                detection_enabled: null
            },
            ...this.device.isDoorbot ? { 
                ding: {
                    active_ding: false,
                    ding_duration: 180,
                    last_ding: 0,
                    last_ding_expires: 0,
                    last_ding_time: 'none'
                } 
            } : {},
            snapshot: {
                mode: savedState?.snapshot?.mode
                    ?  savedState.snapshot.mode[0].toUpperCase() + savedState.snapshot.mode.slice(1)
                    : 'Auto',
                motion: false,
                interval: false,
                autoInterval: savedState?.snapshot?.autoInterval
                    ? savedState.snapshot.autoInterval
                    : true,
                intervalDuration: savedState?.snapshot?.intervalDuration
                    ? savedState.snapshot.intervalDuration
                    : (this.device.operatingOnBattery) ? 600 : 30,
                intervalTimerId: null,
                currentImage: null,
                timestamp: null
            },
            stream: {
                live: {
                    state: 'OFF',
                    status: 'inactive',
                    session: false,
                    publishedStatus: '',
                    worker: new Worker('./devices/camera-livestream.js', {
                        workerData: {
                            doorbotId: this.device.id,
                            deviceName: this.deviceData.name
                        }
                    })
                },
                event: {
                    state: 'OFF',
                    status: 'inactive',
                    session: false,
                    publishedStatus: ''
                },
                keepalive:{ 
                    active: false,
                    session: false,
                    expires: 0
                }
            },
            event_select: {
                state: savedState?.event_select?.state
                    ? savedState.event_select.state
                    : 'Motion 1',
                publishedState: null,
                pollCycle: 0,
                recordingUrl: null,
                recordingUrlExpire: null,
                transcoded: false,
                eventId: '0'
            },
            ...this.device.hasLight ? {
                light: {
                    state: null,
                    setTime: Math.floor(Date.now()/1000)
                }
            } : {},
            ...this.device.hasSiren ? {
                siren: {
                    state: null
                }
            } : {}
        }
      
        this.entity = {
            ...this.entity,
            motion: {
                component: 'binary_sensor',
                device_class: 'motion',
                attributes: true
            },
            stream: {
                component: 'switch',
                attributes: true,
                name: `${this.deviceData.name} Live Stream`,
                icon: 'mdi:cctv'
            },
            event_stream: {
                component: 'switch',
                attributes: true,
                icon: 'mdi:vhs'
            },
            event_select: {
                component: 'select',
                options: [
                    ...(this.device.isDoorbot
                        ? [ 'Ding 1', 'Ding 2', 'Ding 3', 'Ding 4', 'Ding 5', 
                            'Ding 1 (Transcoded)', 'Ding 2 (Transcoded)', 'Ding 3 (Transcoded)', 'Ding 4 (Transcoded)', 'Ding 5 (Transcoded)' ]
                        : []),
                    'Motion 1', 'Motion 2', 'Motion 3', 'Motion 4', 'Motion 5',
                    'Motion 1 (Transcoded)', 'Motion 2 (Transcoded)', 'Motion 3 (Transcoded)', 'Motion 4 (Transcoded)', 'Motion 5 (Transcoded)',
                    'Person 1', 'Person 2', 'Person 3', 'Person 4', 'Person 5',
                    'Person 1 (Transcoded)', 'Person 2 (Transcoded)', 'Person 3 (Transcoded)', 'Person 4 (Transcoded)', 'Person 5 (Transcoded)',
                    'On-demand 1', 'On-demand 2', 'On-demand 3', 'On-demand 4', 'On-demand 5',
                    'On-demand 1 (Transcoded)', 'On-demand 2 (Transcoded)', 'On-demand 3 (Transcoded)', 'On-demand 4 (Transcoded)', 'On-demand 5 (Transcoded)',
                ],
                attributes: true
            },
            ...this.device.isDoorbot ? {
                ding: {
                    component: 'binary_sensor',
                    device_class: 'occupancy',
                    attributes: true,
                    icon: 'mdi:doorbell-video'
                }
            } : {},
            ...this.device.hasLight ? {
                light: {
                    component: 'light'
                }
            } : {},
            ...this.device.hasSiren ? {
                siren: {
                    component: 'switch',
                    icon: 'mdi:alarm-light'
                }
            } : {},
            snapshot: {
                component: 'camera',
                attributes: true
            },
            snapshot_mode: {
                component: 'select',
                options: [ 'Auto', 'Disabled', 'Motion', 'Interval', 'All' ]
            },
            snapshot_interval: {
                component: 'number',
                min: 10,
                max: 604800,
                icon: 'hass:timer'
            },
            info: {
                component: 'sensor',
                device_class: 'timestamp',
                value_template: '{{ value_json["lastUpdate"] | default("") }}'
            }
        }

        this.data.stream.live.worker.on('message', (message) => {
            switch (message) {
                case 'active':
                    this.data.stream.live.status = 'active'
                    this.data.stream.live.session = true
                    break;
                case 'inactive':
                    this.data.stream.live.status = 'inactive'
                    this.data.stream.live.session = false
                    break;
                case 'failed':
                    this.data.stream.live.status = 'failed'
                    this.data.stream.live.session = false
                    break;
                default:
                    this.debug(message, 'wrtc')
                    return
            }
            this.publishStreamState()
        })

        this.device.onNewNotification.subscribe(notification => {
            this.processNotification(notification)
        })

        this.updateSnapshotMode()
        this.scheduleSnapshotRefresh()

        this.updateDeviceState()
    }

    updateDeviceState() {
        const stateData = {
            snapshot: {
                mode: this.data.snapshot.mode,
                autoInterval: this.data.snapshot.autoInterval,
                interval: this.data.snapshot.intervalDuration
            },
            event_select: {
                state: this.data.event_select.state
            }
        }
        this.setSavedState(stateData)
    }

    // Build standard and optional entities for device
    async initAttributeEntities() {
         // If device is wireless publish signal strength entity
        const deviceHealth = await this.device.getHealth()
        if (deviceHealth && !(deviceHealth?.network_connection && deviceHealth.network_connection === 'ethernet')) {
            this.entity.wireless = {
                component: 'sensor',
                device_class: 'signal_strength',
                unit_of_measurement: 'dBm',
                parent_state_topic: 'info/state',
                attributes: 'wireless',
                value_template: '{{ value_json["wirelessSignal"] | default("") }}'
            }
        }

        // If device is battery powered publish battery entity
        if (this.device.batteryLevel || this.hasBattery1 || this.hasBattery2) {
            this.entity.battery = {
                component: 'sensor',
                device_class: 'battery',
                unit_of_measurement: '%',
                state_class: 'measurement',
                parent_state_topic: 'info/state',
                attributes: 'battery',
                value_template: '{{ value_json["batteryLevel"] | default("") }}'
            }
        }

        // Get most recent motion event data
        const lastMotionEvent = (await this.device.getEvents({ limit: 1, kind: 'motion'})).events[0]
        const lastMotionDate = (lastMotionEvent?.created_at) ? new Date(lastMotionEvent.created_at) : false
        this.data.motion.last_ding = lastMotionDate ? Math.floor(lastMotionDate/1000) : 0
        this.data.motion.last_ding_time = lastMotionDate ? utils.getISOTime(lastMotionDate) : ''
        if (lastMotionEvent?.cv_properties) {
            this.data.motion.is_person = (lastMotionEvent.cv_properties.detection_type === 'human') ? true : false
        }

        // Get most recent ding event data
        if (this.device.isDoorbot) {
            const lastDingEvent = (await this.device.getEvents({ limit: 1, kind: 'ding'})).events[0]
            const lastDingDate = (lastDingEvent?.created_at) ? new Date(lastDingEvent.created_at) : false
            this.data.ding.last_ding = lastDingDate ? Math.floor(lastDingDate/1000) : 0
            this.data.ding.last_ding_time = lastDingDate ? utils.getISOTime(lastDingDate) : ''
        }

        // Try to get URL for most recent motion event, if it fails, assume there's no subscription
        const events = await(this.getRecordedEvents('motion', 1))
        const recordingUrl = await this.device.getRecordingUrl(events[0].event_id, { transcoded: false })
        if (!recordingUrl) {
            this.debug('Could not retrieve recording URL for any motion event, assuming no Ring Protect subscription')
            delete this.entity.event_stream
            delete this.entity.event_select
        }

        let stillImageUrlBase = 'localhost'
        let streamSourceUrlBase
        if (process.env.RUNMODE === 'addon') {
            // For the addon we get some values populated from the startup script
            // that queries the HA API via bashio
            stillImageUrlBase = process.env.HAHOSTNAME
            streamSourceUrlBase = process.env.ADDONHOSTNAME
        } else if (process.env.RUNMODE === 'docker') {
            // For docker we don't have any API to query so we just use the IP of the docker container
            // since it probably doesn't have a DNS entry
            streamSourceUrlBase = await utils.getHostIp()
        } else {
            // For the stadalone install we try to get the host FQDN
            streamSourceUrlBase = await utils.getHostFqdn()
        }

        // Set some helper attributes for streaming
        this.data.stream.live.stillImageURL = `https://${stillImageUrlBase}:8123{{ states.camera.${this.device.name.toLowerCase().replace(" ","_")}_snapshot.attributes.entity_picture }}`,
        this.data.stream.live.streamSource = (utils.config().livestream_user && utils.config().livestream_pass)
            ? `rtsp://${utils.config().livestream_user}:${utils.config().livestream_pass}@${streamSourceUrlBase}:8554/${this.deviceId}_live`
            : `rtsp://${streamSourceUrlBase}:8554/${this.deviceId}_live`
    }

    updateSnapshotMode() {
        switch (this.data.snapshot.mode.toLowerCase()) {
            case 'disabled':
                this.data.snapshot.motion = false
                this.data.snapshot.interval = false
                break;
            case 'motion':
                this.data.snapshot.motion = true
                this.data.snapshot.interval = false
                break;
            case 'interval':
                this.data.snapshot.motion = false
                this.data.snapshot.interval = true
                break;
            case 'all':
                this.data.snapshot.motion = true
                this.data.snapshot.interval = true
                break;
            case 'auto':
                this.data.snapshot.motion = true
                this.data.snapshot.interval = (this.device.operatingOnBattery) ? false : true
                break;
        }

        if (this.data.snapshot.interval && this.data.snapshot.autoInterval) {
            // If interval snapshots are enabled but interval is not manually set, try to detect a reasonable defaults
            if (this.device.operatingOnBattery) {
                if (this.device.data.settings.lite_24x7?.enabled) {
                    this.data.snapshot.intervalDuration = this.device.data.settings.lite_24x7.frequency_secs
                } else {
                    this.data.snapshot.intervalDuration = 600
                }
            } else {
                // For wired cameras default to 30 seconds o
                this.data.snapshot.intervalDuration = 30
            }
        }
    }

    // Publish camera capabilities and state and subscribe to events
    async publishState(data) {
        const isPublish = data === undefined ? true : false
        this.publishPolledState(isPublish)

        // Checks for new events or expired recording URL even 3 polling cycles (~1 minute)
        if (this.entity.hasOwnProperty('event_select')) {
            this.data.event_select.pollCycle--
            if (this.data.event_select.pollCycle <= 0) {
                this.data.event_select.pollCycle = 3
                if (await this.updateEventStreamUrl() && !isPublish) {
                    this.publishEventSelectState()
                }
            }
        }

        if (isPublish) {
            // Publish stream state
            this.publishStreamState(isPublish)
            if (this.entity.event_select) {
                this.publishEventSelectState(isPublish)
            }
 
            this.publishDingStates()
            this.publishSnapshotMode()
            if (this.data.snapshot.motion || this.data.snapshot.interval) {
                if (this.data.snapshot.currentImage) {
                    this.publishSnapshot()
                } else {
                    this.refreshSnapshot('interval')
                }

                this.publishSnapshotInterval(isPublish)
            }
            this.publishAttributes()
        }

        // Check for subscription to ding and motion events and attempt to resubscribe
        if (!this.device.data.subscribed === true) {
            this.debug('Camera lost subscription to ding events, attempting to resubscribe...')
            this.device.subscribeToDingEvents().catch(e => { 
                this.debug('Failed to resubscribe camera to ding events. Will retry in 60 seconds.') 
                this.debug(e)
            })
        }
        if (!this.device.data.subscribed_motions === true) {
            this.debug('Camera lost subscription to motion events, attempting to resubscribe...')
            this.device.subscribeToMotionEvents().catch(e => {
                this.debug('Failed to resubscribe camera  to motion events.  Will retry in 60 seconds.')
                this.debug(e)
            })
        }
    }
    
    // Process a ding event
    async processNotification(pushData) {
        // Is it a motion or doorbell ding? (for others we do nothing)
        if (pushData.action !== 'com.ring.push.HANDLE_NEW_DING' && pushData.action !== 'com.ring.push.HANDLE_NEW_motion') { return }

        const dingKind = (pushData.action === 'com.ring.push.HANDLE_NEW_DING') ? 'ding' : 'motion'
        const ding = pushData.ding
        ding.created_at = Math.floor(Date.now()/1000)
        this.debug(`Received ${dingKind} push notification, expires in ${this.data[dingKind].ding_duration} seconds`)

        // Is this a new Ding or refresh of active ding?
        const newDing = (!this.data[dingKind].active_ding) ? true : false
        this.data[dingKind].active_ding = true

        // Update last_ding and expire time
        this.data[dingKind].last_ding = ding.created_at
        this.data[dingKind].last_ding_time = utils.getISOTime(ding.created_at*1000)
        this.data[dingKind].last_ding_expires = this.data[dingKind].last_ding+this.data[dingKind].ding_duration

        // If motion ding and snapshots on motion are enabled, publish a new snapshot
        if (dingKind === 'motion') {
            this.data[dingKind].is_person = (ding.detection_type === 'human') ? true : false
            if (this.data.snapshot.motion) {
                this.refreshSnapshot('motion', ding.image_uuid)
            }
        }

        // Publish MQTT active sensor state
        // Will republish to MQTT for new dings even if ding is already active
        this.publishDingState(dingKind)

        // If new ding, begin expiration loop (only needed for first ding as others just extend time)
        if (newDing) {
            // Loop until current time is > last_ding expires time.  Sleeps until
            // estimated expire time, but may loop if new dings increase last_ding_expires
            while (Math.floor(Date.now()/1000) < this.data[dingKind].last_ding_expires) {
                const sleeptime = (this.data[dingKind].last_ding_expires - Math.floor(Date.now()/1000)) + 1
                await utils.sleep(sleeptime)
            }
            // All dings have expired, set ding state back to false/off and publish
            this.debug(`All ${dingKind} dings for camera have expired`)
            this.data[dingKind].active_ding = false
            this.publishDingState(dingKind)
        }
    }

    // Publishes all current ding states for this camera
    publishDingStates() {
        this.publishDingState('motion')
        if (this.device.isDoorbot) { 
            this.publishDingState('ding') 
        }
    }

    // Publish ding state and attributes
    publishDingState(dingKind) {
        const dingState = this.data[dingKind].active_ding ? 'ON' : 'OFF'
        this.mqttPublish(this.entity[dingKind].state_topic, dingState)

        if (dingKind === 'motion') {
            this.publishMotionAttributes()
        } else {
            this.publishDingAttributes()
        }
    }

    publishMotionAttributes() {
        const attributes = {
            lastMotion: this.data.motion.last_ding,
            lastMotionTime: this.data.motion.last_ding_time,
            personDetected: this.data.motion.is_person
        }
        if (this.device.data.settings && typeof this.device.data.settings.motion_detection_enabled !== 'undefined') {
            this.data.motion.detection_enabled = this.device.data.settings.motion_detection_enabled
            attributes.motionDetectionEnabled = this.data.motion.detection_enabled
        }
        this.mqttPublish(this.entity.motion.json_attributes_topic, JSON.stringify(attributes), 'attr')
    }

    publishDingAttributes() {
        const attributes = {
            lastDing: this.data.ding.last_ding,
            lastDingTime: this.data.ding.last_ding_time
        }
        this.mqttPublish(this.entity.ding.json_attributes_topic, JSON.stringify(attributes), 'attr')
    }

    // Publish camera state for polled attributes (light/siren state, etc)
    // Writes state to custom property to keep from publishing state except
    // when values change from previous polling interval
    publishPolledState(isPublish) {
        if (this.device.hasLight) {
            const lightState = this.device.data.led_status === 'on' ? 'ON' : 'OFF'
            if ((lightState !== this.data.light.state && Date.now()/1000 - this.data.light.setTime > 30) || isPublish) {
                this.data.light.state = lightState
                this.mqttPublish(this.entity.light.state_topic, this.data.light.state)
            }
        }
        if (this.device.hasSiren) {
            const sirenState = this.device.data.siren_status.seconds_remaining > 0 ? 'ON' : 'OFF'
            if (sirenState !== this.data.siren.state || isPublish) {
                this.data.siren.state = sirenState
                this.mqttPublish(this.entity.siren.state_topic, this.data.siren.state)
            }
        }

        if (this.device.data.settings.motion_detection_enabled !== this.data.motion.detection_enabled || isPublish) {
            this.publishMotionAttributes()
        }
    }

    // Publish device data to info topic
    async publishAttributes() {
        const attributes = {}
        const deviceHealth = await this.device.getHealth()

        if (this.device.batteryLevel || this.hasBattery1 || this.hasBattery2) {
            if (deviceHealth && deviceHealth.hasOwnProperty('active_battery')) {
                attributes.activeBattery = deviceHealth.active_battery
            }

            // Reports the level of the currently active battery, might be null if removed so report 0% in that case
            attributes.batteryLevel = this.device.batteryLevel && utils.isNumeric(this.device.batteryLevel) 
                ? this.device.batteryLevel 
                : 0

            // Must have at least one battery, but it might not be inserted, so report 0% in that case
            attributes.batteryLife = this.device.data.hasOwnProperty('battery_life') && utils.isNumeric(this.device.data.battery_life) 
                ? Number.parseFloat(this.device.data.battery_life)
                : 0
            
            if (this.hasBattery2) {
                attributes.batteryLife2 = this.device.data.hasOwnProperty('battery_life_2') && utils.isNumeric(this.device.data.battery_life_2)
                    ? Number.parseFloat(this.device.data.battery_life_2)
                    : 0
            }
        }

        if (deviceHealth) {
            attributes.firmwareStatus = deviceHealth.firmware
            attributes.lastUpdate = deviceHealth.updated_at.slice(0,-6)+"Z"
            if (deviceHealth.hasOwnProperty('network_connection') && deviceHealth.network_connection === 'ethernet') {
                attributes.wiredNetwork = this.device.data.alerts.connection
            } else {
                attributes.wirelessNetwork = deviceHealth.wifi_name
                attributes.wirelessSignal = deviceHealth.latest_signal_strength
            }
            attributes.stream_Source = this.data.stream.live.streamSource
            attributes.still_Image_URL = this.data.stream.live.stillImageURL
        }

        if (Object.keys(attributes).length > 0) {
            this.mqttPublish(this.entity.info.state_topic, JSON.stringify(attributes), 'attr')
            this.publishAttributeEntities(attributes)
        }
    }

    publishSnapshotInterval(isPublish) {
        if (isPublish) {
            this.mqttPublish(this.entity.snapshot_interval.state_topic, this.data.snapshot.intervalDuration.toString())
        } else {
            // Update snapshot frequency in case it's changed
            if (this.data.snapshot.autoInterval && this.data.snapshot.intervalDuration !== this.device.data.settings.lite_24x7.frequency_secs) {
                this.data.snapshot.intervalDuration = this.device.data.settings.lite_24x7.frequency_secs
                clearInterval(this.data.snapshot.intervalTimerId)
                this.scheduleSnapshotRefresh()
            }
            this.mqttPublish(this.entity.snapshot_interval.state_topic, this.data.snapshot.intervalDuration.toString())
        }
    }

    publishSnapshotMode() {
        this.mqttPublish(this.entity.snapshot_mode.state_topic, this.data.snapshot.mode)
    }

    publishStreamState(isPublish) {
        ['live', 'event'].forEach(type => {
            const entityProp = (type === 'live') ? 'stream' : `${type}_stream`
            if (this.entity.hasOwnProperty(entityProp)) {
                const streamState = (this.data.stream[type].status === 'active' || this.data.stream[type].status === 'activating') ? 'ON' : 'OFF'
                if (streamState !== this.data.stream[type].state || isPublish) {
                    this.data.stream[type].state = streamState
                    this.mqttPublish(this.entity[entityProp].state_topic, this.data.stream[type].state)
                    // Publish state to IPC broker as well
                    utils.event.emit('mqtt_ipc_publish', this.entity[entityProp].state_topic, this.data.stream[type].state)
                }

                if (this.data.stream[type].publishedStatus !== this.data.stream[type].status || isPublish) {
                    this.data.stream[type].publishedStatus = this.data.stream[type].status
                    const attributes = { status: this.data.stream[type].status }
                    this.mqttPublish(this.entity[entityProp].json_attributes_topic, JSON.stringify(attributes), 'attr')
                    // Publish attribute state to IPC broker as well
                    utils.event.emit('mqtt_ipc_publish', this.entity[entityProp].json_attributes_topic, JSON.stringify(attributes))
                }
            }
        })
    }

    publishEventSelectState(isPublish) {
        if (this.data.event_select.state !== this.data.event_select.publishedState || isPublish) {
            this.data.event_select.publishedState = this.data.event_select.state
            this.mqttPublish(this.entity.event_select.state_topic, this.data.event_select.state)
        }
        const attributes = { 
            recordingUrl: this.data.event_select.recordingUrl,
            eventId: this.data.event_select.eventId
        }
        this.mqttPublish(this.entity.event_select.json_attributes_topic, JSON.stringify(attributes), 'attr', '<recording_url_masked>')
    }

    // Publish snapshot image/metadata
    publishSnapshot() {
        this.mqttPublish(this.entity.snapshot.topic, this.data.snapshot.currentImage, 'mqtt', '<binary_image_data>')
        this.mqttPublish(this.entity.snapshot.json_attributes_topic, JSON.stringify({ timestamp: this.data.snapshot.timestamp }), 'attr')
    }

    // Refresh snapshot on scheduled interval
    scheduleSnapshotRefresh() {
        this.data.snapshot.intervalTimerId = setInterval(() => {
            if (this.isOnline() && this.data.snapshot.interval && !(this.data.snapshot.motion && this.data.motion.active_ding)) {
                this.refreshSnapshot('interval')
            }
        }, this.data.snapshot.intervalDuration * 1000)
    }

    async refreshSnapshot(type, image_uuid) {
        let newSnapshot = false

        if (this.device.snapshotsAreBlocked) {
            this.debug('Snapshots are unavailable, check if motion capture is disabled manually or via modes settings')
            return
        }

        try {
            switch (type) {
                case 'interval':
                    this.debug('Requesting an updated interval snapshot')
                    newSnapshot = await this.device.getSnapshot()
                    break;
                case 'motion':
                    if (image_uuid) {
                        this.debug(`Requesting motion snapshot using notification image UUID: ${image_uuid}`)
                        newSnapshot = await this.device.getSnapshot({ uuid: image_uuid })
                    } else if (!this.device.operatingOnBattery) {
                        this.debug('Requesting an updated motion snapshot')
                        newSnapshot = await this.device.getSnapshot()
                    } else {
                        this.debug('Motion snapshot needed but notification did not contain image UUID and battery cameras are unable to snapshot while recording')
                    }            
            }
        } catch (error) {
            this.debug(error) 
            this.debug('Failed to retrieve updated snapshot')
        }

        if (newSnapshot) {
            this.debug('Successfully retrieved updated snapshot')
            this.data.snapshot.currentImage = newSnapshot
            this.data.snapshot.timestamp = Math.round(Date.now()/1000)
            this.publishSnapshot()
        }
    }

    async startLiveStream(rtspPublishUrl) {
        this.data.stream.live.session = true
        const streamData = {
            rtspPublishUrl,
            sessionId: false,
            authToken: false
        }

        try {
            if (this.device.isRingEdgeEnabled) {
                this.debug('Initializing a live stream session for Ring Edge')
                const auth = await this.device.restClient.getCurrentAuth()
                streamData.authToken = auth.access_token
            } else {
                this.debug('Initializing a live stream session for Ring cloud')
                const liveCall = await this.device.restClient.request({
                    method: 'POST',
                    url: this.device.doorbotUrl('live_call')
                })
                if (liveCall.data?.session_id) {
                    streamData.sessionId = liveCall.data.session_id
                }
            }
        } catch(error) {
            if (error?.response?.statusCode === 403) {
                this.debug(`Camera returned 403 when starting a live stream.  This usually indicates that live streaming is blocked by Modes settings.  Check your Ring app and verify that you are able to stream from this camera with the current Modes settings.`)
            } else {
                this.debug(error)
            }
        }

        if (streamData.sessionId || streamData.authToken) {
            this.debug('Live stream session successfully initialized, starting worker')
            this.data.stream.live.worker.postMessage({ command: 'start', streamData })
        } else {
            this.debug('Live stream activation failed to initialize session data')
            this.data.stream.live.status = 'failed'
            this.data.stream.live.session = false
            this.publishStreamState()
        }
    }

    async startEventStream(rtspPublishUrl) {
        const eventSelect = this.data.event_select.state.split(' ')
        const eventType = eventSelect[0].toLowerCase().replace('-', '_')
        const eventNumber = eventSelect[1]

        if (this.data.event_select.recordingUrl === '<No Valid URL>') {
            this.debug(`No valid recording was found for the ${(eventNumber==1?"":eventNumber==2?"2nd ":eventNumber==3?"3rd ":eventNumber+"th ")}most recent ${eventType} event!`)
            this.data.stream.event.status = 'failed'
            this.data.stream.event.session = false
            this.publishStreamState()
            return
        }

        this.debug(`Streaming the ${(eventNumber==1?"":eventNumber==2?"2nd ":eventNumber==3?"3rd ":eventNumber+"th ")}most recently recorded ${eventType} event`)

        try {
            if (this.data.event_select.transcoded) {
                // Ring transcoded videos are poorly optimized for RTSP streaming so they must be re-encoded on-the-fly
                this.data.stream.event.session = spawn(pathToFfmpeg, [
                    '-re',
                    '-i', this.data.event_select.recordingUrl,
                    '-map', '0:v',
                    '-map', '0:a',
                    '-map', '0:a',
                    '-c:v', 'libx264',
                    '-g', '20',
                    '-keyint_min', '10',
                    '-crf', '18',
                    '-preset', 'ultrafast',
                    '-c:a:0', 'copy',
                    '-c:a:1', 'libopus',
                    '-flags', '+global_header',
                    '-rtsp_transport', 'tcp',
                    '-f', 'rtsp',
                    rtspPublishUrl
                ])
            } else {
                this.data.stream.event.session = spawn(pathToFfmpeg, [
                    '-re',
                    '-i', this.data.event_select.recordingUrl,
                    '-map', '0:v',
                    '-map', '0:a',
                    '-map', '0:a',
                    '-c:v', 'copy',
                    '-c:a:0', 'copy',
                    '-c:a:1', 'libopus',
                    '-flags', '+global_header',
                    '-rtsp_transport', 'tcp',
                    '-f', 'rtsp',
                    rtspPublishUrl
                ])
            }

            this.data.stream.event.session.on('spawn', async () => {
                this.debug(`The recorded ${eventType} event stream has started`)
                this.data.stream.event.status = 'active'
                this.publishStreamState()
            })

            this.data.stream.event.session.on('close', async () => {
                this.debug(`The recorded ${eventType} event stream has ended`)
                this.data.stream.event.status = 'inactive'
                this.data.stream.event.session = false
                this.publishStreamState()
            })
        } catch(e) {
            this.debug(e)
            this.data.stream.event.status = 'failed'
            this.data.stream.event.session = false
            this.publishStreamState()
        }
    }

    async startKeepaliveStream() {
        const duration = 86400
        if (this.data.stream.keepalive.active) { return }
        this.data.stream.keepalive.active = true

        const rtspPublishUrl = (utils.config().livestream_user && utils.config().livestream_pass)
            ? `rtsp://${utils.config().livestream_user}:${utils.config().livestream_pass}@localhost:8554/${this.deviceId}_live`
            : `rtsp://localhost:8554/${this.deviceId}_live`
        
        this.debug(`Starting a keepalive stream for camera`)

        // Keepalive stream is used only when the live stream is started 
        // manually. It copies only the audio stream to null output just to
        // trigger rtsp server to start the on-demand stream and keep it running
        // when there are no other RTSP readers.
        this.data.stream.keepalive.session = spawn(pathToFfmpeg, [
            '-i', rtspPublishUrl,
            '-map', '0:a:0',
            '-c:a', 'copy',
            '-f', 'null',
            '/dev/null'
        ])

        this.data.stream.keepalive.session.on('spawn', async () => {
            this.debug(`The keepalive stream has started`)
        })

        this.data.stream.keepalive.session.on('close', async () => {
            this.data.stream.keepalive.active = false
            this.data.stream.keepalive.session = false
            this.debug(`The keepalive stream has stopped`)
        })

        // The keepalive stream will time out after 24 hours
        this.data.stream.keepalive.expires = Math.floor(Date.now()/1000) + duration
        while (this.data.stream.keepalive.active && Math.floor(Date.now()/1000) < this.data.stream.keepalive.expires) {
            await utils.sleep(60)
        }
        this.data.stream.keepalive.session.kill()
        this.data.stream.keepalive.active = false
        this.data.stream.keepalive.session = false
    }

    async updateEventStreamUrl() {
        const eventSelect = this.data.event_select.state.split(' ')
        const eventType = eventSelect[0].toLowerCase().replace('-', '_')
        const eventNumber = eventSelect[1]
        const transcoded = eventSelect[2] === '(Transcoded)' ? true : false
        const urlExpired = Math.floor(Date.now()/1000) - this.data.event_select.recordingUrlExpire > 0 ? true : false
        let selectedEvent
        let recordingUrl

        try {
            const events = await(this.getRecordedEvents(eventType, eventNumber))
            selectedEvent = events[eventNumber-1]

            if (selectedEvent) {
                if (selectedEvent.event_id !== this.data.event_select.eventId || this.data.event_select.transcoded !== transcoded) {
                    if (this.data.event_select.recordingUrl) {
                        this.debug(`New ${this.data.event_select.state} event detected, updating the recording URL`)
                    }
                    recordingUrl = await this.device.getRecordingUrl(selectedEvent.event_id, { transcoded })
                } else if (urlExpired) {
                    this.debug(`Previous ${this.data.event_select.state} URL has expired, updating the recording URL`)
                    recordingUrl = await this.device.getRecordingUrl(selectedEvent.event_id, { transcoded })
                }
            }
        } catch(error) {
            this.debug(error)
            this.debug(`Failed to retrieve recording URL for ${this.data.event_select.state} event`)
        }

        if (recordingUrl) {
            this.data.event_select.recordingUrl = recordingUrl
            this.data.event_select.transcoded = transcoded
            this.data.event_select.eventId = selectedEvent.event_id

            // Try to parse URL parameters to set expire time
            const urlSearch = new URLSearchParams(recordingUrl)
            const amzExpires = Number(urlSearch.get('X-Amz-Expires'))
            const amzDate = urlSearch.get('X-Amz-Date')
            if (amzDate && amzExpires && amzExpires !== 'NaN') {
                const [_, year, month, day, hour, min, sec] = amzDate.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/)
                this.data.event_select.recordingUrlExpire = Math.floor(Date.UTC(year, month-1, day, hour, min, sec)/1000)+amzExpires-75
            } else {
                this.data.event_select.recordingUrlExpire = Math.floor(Date.now()/1000) + 600
            }
        } else if (urlExpired || !selectedEvent) {
            this.data.event_select.recordingUrl = '<No Valid URL>'
            this.data.event_select.transcoded = transcoded
            this.data.event_select.eventId = '0'
            return false
        }

        return recordingUrl
    }

    async getRecordedEvents(eventType, eventNumber) {
        let events = []
        try {
            if (eventType !== 'person') {
                events = ((await this.device.getEvents({ 
                    limit: eventNumber+2,
                    kind: eventType
                })).events).filter(event => event.recording_status === 'ready')
            } else {
                let loop = 0
                while (loop <= 3 && events.length < eventNumber) {
                    events = ((await this.device.getEvents({ 
                        limit: 50,
                        kind: 'motion'
                    })).events).filter(event => event.recording_status === 'ready' && event.cv_properties.detection_type === 'human')
                    loop++
                    await utils.msleep(100)
                }
            }
        } catch(error) {
            this.debug(error)
        }

        if (events.length === 0) {
            this.debug(`No recording corresponding to ${this.data.event_select.state} was found in event history`)
        }

        return events
    }

    // Process messages from MQTT command topic
    processCommand(command, message) {
        const entityKey = command.split('/')[0]
        if (!this.entity.hasOwnProperty(entityKey)) {
            this.debug(`Received message to unknown command topic: ${command}`)
            return
        }

        switch (command) {
            case 'light/command':
                this.setLightState(message)
                break;
            case 'siren/command':
                this.setSirenState(message)
                break;
            case 'snapshot/command':
                this.setSnapshotInterval(message)
                break;
            case 'snapshot_mode/command':
                this.setSnapshotMode(message)
                break;
            case 'snapshot_interval/command':
                this.setSnapshotInterval(message)
                break;
            case 'stream/command':
                this.setLiveStreamState(message)
                break;
            case 'event_stream/command':
                this.setEventStreamState(message)
                break;
            case 'event_select/command':
                this.setEventSelect(message)
                break;
        }
    }

    // Set switch target state on received MQTT command message
    async setLightState(message) {
        this.debug(`Received set light state ${message}`)
        const command = message.toUpperCase()

        switch (command) {
            case 'ON':
            case 'OFF':
                this.data.light.setTime = Math.floor(Date.now()/1000)
                await this.device.setLight(command === 'ON' ? true : false)
                this.data.light.state = command
                this.mqttPublish(this.entity.light.state_topic, this.data.light.state)
                break;
            default:
                this.debug('Received unknown command for light')
        }
    }

    // Set switch target state on received MQTT command message
    async setSirenState(message) {
        this.debug(`Received set siren state ${message}`)
        const command = message.toLowerCase()

        switch (command) {
            case 'on':
            case 'off':
                await this.device.setSiren(command === 'on' ? true : false)
                break;
            default:
                this.debug('Received unknown command for siren')
        }
    }

    // Set refresh interval for snapshots
    setSnapshotInterval(message) {
        this.debug(`Received set snapshot refresh interval ${message}`)
        if (isNaN(message)) {
            this.debug('Snapshot interval value received but not a number')
        } else if (!(message >= 10 && message <= 604800)) {
            this.debug('Snapshot interval value received but out of range (10-604800)')
        } else {
            this.data.snapshot.intervalDuration = Math.round(message)
            this.data.snapshot.autoInterval = false
            if (this.data.snapshot.mode === 'auto') {
                if (this.data.snapshot.motion && this.data.snapshot.interval) {
                    this.data.snapshot.mode = 'all'               
                } else if (this.data.snapshot.interval) {
                    this.data.snapshot.mode = 'interval'
                } else if (this.data.snapshot.motion) {
                    this.data.snapshot.mode = 'motion'
                } else {
                    this.data.snapshot.mode = 'disabled'
                }
                this.updateSnapshotMode()
                this.publishSnapshotMode()    
            }
            clearInterval(this.data.snapshot.intervalTimerId)
            this.scheduleSnapshotRefresh()
            this.publishSnapshotInterval()
            this.debug('Snapshot refresh interval has been set to '+this.data.snapshot.intervalDuration+' seconds')
            this.updateDeviceState()
        }
    }

    setSnapshotMode(message) {
        this.debug(`Received set snapshot mode to ${message}`)
        const mode = message[0].toUpperCase() + message.slice(1)
        switch(mode) {
            case 'Auto':
                this.data.snapshot.autoInterval = true                
            case 'Disabled':
            case 'Motion':
            case 'Interval':
            case 'All':
                this.data.snapshot.mode = mode
                this.updateSnapshotMode()
                this.publishSnapshotMode()
                if (message === 'Auto') {
                    clearInterval(this.data.snapshot.intervalTimerId)
                    this.scheduleSnapshotRefresh()
                    this.publishSnapshotInterval()
                }
                this.debug(`Snapshot mode has been set to ${mode}`)
                this.updateDeviceState()
                break;
            default:
                this.debug(`Received invalid snapshot mode command`)
        }
    }

    setLiveStreamState(message) {
        const command = message.toLowerCase()
        this.debug(`Received set live stream state ${message}`)
        if (command.startsWith('on-demand')) {
            if (this.data.stream.live.status === 'active' || this.data.stream.live.status === 'activating') {
                this.publishStreamState()
            } else {
                this.data.stream.live.status = 'activating'
                this.publishStreamState()
                this.startLiveStream(message.split(' ')[1]) // Portion after space is the RTSP publish URL
            }
        } else {
            switch (command) {
                case 'on':
                    // Stream was manually started, create a dummy, audio only
                    // RTSP source stream to trigger stream startup and keep it active
                    this.startKeepaliveStream()
                    break;
                case 'off':
                    if (this.data.stream.keepalive.session) {
                        this.debug('Stopping the keepalive stream')
                        this.data.stream.keepalive.session.kill()
                    } else if (this.data.stream.live.session) {
                        const streamData = {
                            deviceId: this.deviceId,
                            deviceName: this.device.name
                        }
                        this.data.stream.live.worker.postMessage({ command: 'stop' })
                    } else {
                        this.data.stream.live.status = 'inactive'
                        this.publishStreamState()
                    }
                    break;
                default:
                    this.debug(`Received unknown command for live stream`)
            }
        }
    }

    setEventStreamState(message) {
        const command = message.toLowerCase()
        this.debug(`Received set event stream state ${message}`)
        if (command.startsWith('on-demand')) {
            if (this.data.stream.event.status === 'active' || this.data.stream.event.status === 'activating') {
                this.publishStreamState()
            } else {
                this.data.stream.event.status = 'activating'
                this.publishStreamState()
                this.startEventStream(message.split(' ')[1]) // Portion after backslash is RTSP publish URL
            }
        } else {
            switch (command) {
                case 'on':
                    this.debug(`Event stream can only be started on-demand!`)
                    break;
                case 'off':
                    if (this.data.stream.event.session) {
                        this.data.stream.event.session.kill()
                    } else {
                        this.data.stream.event.status = 'inactive'
                        this.publishStreamState()
                    }
                    break;
                default:
                    this.debug(`Received unknown command for event stream`)
            }
        }
    }

    // Set Stream Select Option
    async setEventSelect(message) {
        this.debug(`Received set event stream to ${message}`)
        if (this.entity.event_select.options.includes(message)) {
            if (this.data.stream.event.session) {
                this.data.stream.event.session.kill()
            }
            this.data.event_select.state = message
            this.updateDeviceState()
            await this.updateEventStreamUrl()
            this.publishEventSelectState()
        } else {
            this.debug('Received invalid value for event stream')
        }
    }
}
