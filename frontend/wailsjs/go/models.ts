export namespace main {
	
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

