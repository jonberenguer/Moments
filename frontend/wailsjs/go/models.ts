export namespace main {
	
	export class ExportFallback {
	    label: string;
	    args: string[];
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new ExportFallback(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.label = source["label"];
	        this.args = source["args"];
	        this.message = source["message"];
	    }
	}
	export class ExportStep {
	    label: string;
	    args: string[];
	    fallbackOnFail?: ExportFallback;
	
	    static createFrom(source: any = {}) {
	        return new ExportStep(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.label = source["label"];
	        this.args = source["args"];
	        this.fallbackOnFail = this.convertValues(source["fallbackOnFail"], ExportFallback);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ExportPayload {
	    jobId: string;
	    steps: ExportStep[];
	    encoderOverride: string;
	    exportQuality: string;
	    exportBitrate: number;
	    tempDir: string;
	
	    static createFrom(source: any = {}) {
	        return new ExportPayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.jobId = source["jobId"];
	        this.steps = this.convertValues(source["steps"], ExportStep);
	        this.encoderOverride = source["encoderOverride"];
	        this.exportQuality = source["exportQuality"];
	        this.exportBitrate = source["exportBitrate"];
	        this.tempDir = source["tempDir"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class FFmpegStatus {
	    available: boolean;
	    path: string;
	
	    static createFrom(source: any = {}) {
	        return new FFmpegStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.available = source["available"];
	        this.path = source["path"];
	    }
	}
	export class FileFilterInput {
	    name: string;
	    extensions: string[];
	
	    static createFrom(source: any = {}) {
	        return new FileFilterInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.extensions = source["extensions"];
	    }
	}
	export class GPUCaps {
	    nvenc: boolean;
	    amf: boolean;
	    qsv: boolean;
	    v4l2m2m: boolean;
	    cpu: boolean;
	    vp9: boolean;
	    opus: boolean;
	    vorbis: boolean;
	    gif: boolean;
	    nvencNeedsCuda: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GPUCaps(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.nvenc = source["nvenc"];
	        this.amf = source["amf"];
	        this.qsv = source["qsv"];
	        this.v4l2m2m = source["v4l2m2m"];
	        this.cpu = source["cpu"];
	        this.vp9 = source["vp9"];
	        this.opus = source["opus"];
	        this.vorbis = source["vorbis"];
	        this.gif = source["gif"];
	        this.nvencNeedsCuda = source["nvencNeedsCuda"];
	    }
	}
	export class MediaEntry {
	    name: string;
	    path: string;
	    mime: string;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new MediaEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.mime = source["mime"];
	        this.size = source["size"];
	    }
	}

}

