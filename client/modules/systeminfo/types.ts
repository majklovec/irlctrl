// Public data shapes the `systeminfo` module exchanges over RPC and renders
// on the device card. Kept free of imports so both the backend provider tree
// and the frontend card can import it without creating a cycle.

/** Identity of the board this device runs on. */
export interface BoardInfo {
    /** Human board model, e.g. "Orange Pi 5 Plus" / "Raspberry Pi 5 Model B Rev 1.0". */
    model: string;
    /** Vendor, e.g. "Xunlong" / "Raspberry Pi Foundation". */
    vendor: string;
    /** Short platform identifier, e.g. "Orange Pi 5 Plus (RK3588)". */
    platformName: string;
}

export interface CpuInfo {
    model: string;
    manufacturer: string;
    architecture: string;
    cores: number;
    /** Live average frequency in MHz (0 when no scaling driver is present). */
    speedMHz: number;
    /** Overall busy percent, filled by `getSystemInfo()` from a sampled pair. */
    overallLoad: number;
    /** Busy percent per core, parallel to `cores` (filled by `getSystemInfo()`). */
    loadPerCore: number[];
}

export interface TemperatureSensor {
    /** Sysfs zone id, e.g. "thermal_zone0". */
    zone: string;
    /** Sysfs `type` (or "vcgencmd-gpu" for the Raspberry Pi GPU reading). */
    type: string;
    /** Board-specific human label ("SoC", "Big Core 0", …) when known. */
    label?: string;
    /** Temperature in °C. */
    tempC: number;
}

export interface FanSpeed {
    name: string;
    rpm: number;
}

export interface Voltage {
    name: string;
    volts: number;
}

/** Raspberry Pi `vcgencmd get_throttled` flags. */
export interface ThrottlingState {
    underVoltage: boolean;
    armFreqCapped: boolean;
    currentlyThrottled: boolean;
    softTempLimit: boolean;
    /** Raw flag word, for the curious. */
    raw?: number;
}

export interface MemoryInfo {
    totalBytes: number;
    freeBytes: number;
    availableBytes: number;
    usedBytes: number;
    buffersBytes: number;
    cachedBytes: number;
    swapTotalBytes: number;
    swapFreeBytes: number;
    swapUsedBytes: number;
}

export interface FilesystemInfo {
    device: string;
    mount: string;
    type: string;
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usePercent: number;
}

export interface PhysicalDiskInfo {
    name: string;
    model: string;
    vendor: string;
    sizeBytes: number;
    removable: boolean;
    rotational: boolean;
    readBytesPerSec: number;
    writeBytesPerSec: number;
    ioUtilization: number;
}

export interface NetworkInterfaceInfo {
    iface: string;
    mac: string;
    ip4?: string;
    ip6?: string;
    internal: boolean;
    operState?: string;
    speedMbps?: number;
    rxBytesPerSec?: number;
    txBytesPerSec?: number;
}

export interface OsInfo {
    platform: string;
    distro: string;
    version: string;
    kernel: string;
    arch: string;
    hostname: string;
    uptimeSec: number;
    loadAvg: [number, number, number];
}

/** One `systeminfo.get` response. */
export interface SystemInfo {
    board: BoardInfo;
    os: OsInfo;
    cpu: CpuInfo;
    temperatures: TemperatureSensor[];
    fans: FanSpeed[];
    voltages: Voltage[];
    /** Present only on boards that expose throttling flags (Raspberry Pi). */
    throttling?: ThrottlingState;
    memory: MemoryInfo;
    filesystems: FilesystemInfo[];
    physicalDisks: PhysicalDiskInfo[];
    network: NetworkInterfaceInfo[];
}
