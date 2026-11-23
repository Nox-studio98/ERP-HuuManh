// node_modules/hono/dist/http-exception.js
/**
* `HTTPException` must be used when a fatal error such as authentication failure occurs.
*
* @see {@link https://hono.dev/docs/api/exception}
*
* @param {StatusCode} status - status code of HTTPException
* @param {HTTPExceptionOptions} options - options of HTTPException
* @param {HTTPExceptionOptions["res"]} options.res - response of options of HTTPException
* @param {HTTPExceptionOptions["message"]} options.message - message of options of HTTPException
* @param {HTTPExceptionOptions["cause"]} options.cause - cause of options of HTTPException
*
* @example
* ```ts
* import { HTTPException } from 'hono/http-exception'
*
* // ...
*
* app.post('/auth', async (c, next) => {
*   // authentication
*   if (authorized === false) {
*     throw new HTTPException(401, { message: 'Custom error message' })
*   }
*   await next()
* })
* ```
*/
var HTTPException = class extends Error {
	res;
	status;
	/**
	* Creates an instance of `HTTPException`.
	* @param status - HTTP status code for the exception. Defaults to 500.
	* @param options - Additional options for the exception.
	*/
	constructor(status = 500, options) {
		super(options?.message, { cause: options?.cause });
		this.res = options?.res;
		this.status = status;
	}
	/**
	* Returns the response object associated with the exception.
	* If a response object is not provided, a new response is created with the error message and status code.
	* @returns The response object.
	*/
	getResponse() {
		if (this.res) return new Response(this.res.body, {
			status: this.status,
			headers: this.res.headers
		});
		return new Response(this.message, { status: this.status });
	}
};
// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = Symbol();
// node_modules/hono/dist/utils/buffer.js
var bufferToFormData = (arrayBuffer, contentType) => {
	return new Response(arrayBuffer, { headers: { "Content-Type": contentType.replace(/^[^;]+/, (mediaType) => mediaType.toLowerCase()) } }).formData();
};
// node_modules/hono/dist/utils/body.js
var MAX_NESTED_OBJECTS = 1e4;
var isRawRequest = (request) => "headers" in request;
var parseBody$1 = async (request, options = Object.create(null)) => {
	const { all = false, dot = false } = options;
	const mediaType = (isRawRequest(request) ? request.headers : request.raw.headers).get("Content-Type")?.split(";")[0].trim().toLowerCase();
	if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") return parseFormData(request, {
		all,
		dot
	});
	return {};
};
/**
* Parses form data from a request.
*
* @template T - The type of the parsed body data.
* @param {HonoRequest | Request} request - The request object containing form data.
* @param {ParseBodyOptions} options - Options for parsing the form data.
* @returns {Promise<T>} The parsed body data.
*/
async function parseFormData(request, options) {
	if (!isRawRequest(request) && request.bodyCache.formData) return convertFormDataToBodyData(await request.bodyCache.formData, options);
	const headers = isRawRequest(request) ? request.headers : request.raw.headers;
	const formDataPromise = bufferToFormData(await request.arrayBuffer(), headers.get("Content-Type") || "");
	if (!isRawRequest(request)) request.bodyCache.formData = formDataPromise;
	const formData = await formDataPromise;
	if (formData) return convertFormDataToBodyData(formData, options);
	return {};
}
/**
* Converts form data to body data based on the provided options.
*
* @template T - The type of the parsed body data.
* @param {FormData} formData - The form data to convert.
* @param {ParseBodyOptions} options - Options for parsing the form data.
* @returns {T} The converted body data.
*/
function convertFormDataToBodyData(formData, options) {
	const form = Object.create(null);
	const nestingState = { count: 0 };
	formData.forEach((value, key) => {
		if (!(options.all || key.endsWith("[]"))) form[key] = value;
		else handleParsingAllValues(form, key, value);
	});
	if (options.dot) Object.entries(form).forEach(([key, value]) => {
		if (key.includes(".")) {
			handleParsingNestedValues(form, key, value, nestingState);
			delete form[key];
		}
	});
	return form;
}
/**
* Handles parsing all values for a given key, supporting multiple values as arrays.
*
* @param {BodyData} form - The form data object.
* @param {string} key - The key to parse.
* @param {FormDataEntryValue} value - The value to assign.
*/
var handleParsingAllValues = (form, key, value) => {
	if (form[key] !== void 0) {
		if (Array.isArray(form[key])) form[key].push(value);
		else form[key] = [form[key], value];
	} else if (!key.endsWith("[]")) form[key] = value;
	else form[key] = [value];
};
/**
* Handles parsing nested values using dot notation keys.
*
* @param {BodyData} form - The form data object.
* @param {string} key - The dot notation key.
* @param {BodyDataValue} value - The value to assign.
* @param {{ count: number }} state - The state object tracking nesting depth.
*/
var handleParsingNestedValues = (form, key, value, state) => {
	if (/(?:^|\.)__proto__\./.test(key)) return;
	let nestedForm = form;
	const keys = key.split(".", 34);
	if (keys.length > 33) throwNestingLimitExceeded();
	keys.forEach((key, index) => {
		if (index === keys.length - 1) nestedForm[key] = value;
		else {
			if (!nestedForm[key] || typeof nestedForm[key] !== "object" || Array.isArray(nestedForm[key]) || nestedForm[key] instanceof File) {
				if (state.count++ >= MAX_NESTED_OBJECTS) throwNestingLimitExceeded();
				nestedForm[key] = Object.create(null);
			}
			nestedForm = nestedForm[key];
		}
	});
};
var throwNestingLimitExceeded = () => {
	throw new Error("Nesting limit exceeded");
};
// node_modules/hono/dist/utils/url.js
var splitPath = (path) => {
	const paths = path.split("/");
	if (paths[0] === "") paths.shift();
	return paths;
};
var splitRoutingPath = (routePath) => {
	const { groups, path } = extractGroupsFromPath(routePath);
	return replaceGroupMarks(splitPath(path), groups);
};
var extractGroupsFromPath = (path) => {
	const groups = [];
	path = path.replace(/\{[^}]+\}/g, (match, index) => {
		const mark = `@${index}`;
		groups.push([mark, match]);
		return mark;
	});
	return {
		groups,
		path
	};
};
var replaceGroupMarks = (paths, groups) => {
	for (let i = groups.length - 1; i >= 0; i--) {
		const [mark] = groups[i];
		for (let j = paths.length - 1; j >= 0; j--) if (paths[j].includes(mark)) {
			paths[j] = paths[j].replace(mark, groups[i][1]);
			break;
		}
	}
	return paths;
};
var patternCache = {};
var getPattern = (label, next) => {
	if (label === "*") return "*";
	const match = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
	if (match) {
		const cacheKey = `${label}#${next}`;
		if (!patternCache[cacheKey]) {
			if (match[2]) patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [
				cacheKey,
				match[1],
				new RegExp(`^${match[2]}(?=/${next})`)
			] : [
				label,
				match[1],
				new RegExp(`^${match[2]}$`)
			];
			else patternCache[cacheKey] = [
				label,
				match[1],
				true
			];
		}
		return patternCache[cacheKey];
	}
	return null;
};
var tryDecode = (str, decoder) => {
	try {
		return decoder(str);
	} catch {
		return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
			try {
				return decoder(match);
			} catch {
				return match;
			}
		});
	}
};
var decodeURIWithPreservedPercent = (value) => decodeURI(value.includes("%25") ? value.replace(/%25/g, "%2525") : value);
var getPath = (request) => {
	const url = request.url;
	const start = url.indexOf("/", url.indexOf(":") + 4);
	let i = start;
	for (; i < url.length; i++) {
		const charCode = url.charCodeAt(i);
		if (charCode === 37) {
			const queryIndex = url.indexOf("?", i);
			const hashIndex = url.indexOf("#", i);
			const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
			const path = url.slice(start, end);
			const decoded = tryDecode(path, decodeURIWithPreservedPercent);
			if (/%(?![0-9A-Fa-f]{2})/.test(path)) {
				const rewritten = new URL("http://localhost");
				rewritten.pathname = decoded.replace(/[\\\t\n\r]/g, encodeURIComponent);
				if (tryDecode(rewritten.pathname, decodeURIWithPreservedPercent) !== decoded) return tryDecode(path.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"), decodeURIWithPreservedPercent);
			}
			return decoded;
		} else if (charCode === 63 || charCode === 35) break;
	}
	return url.slice(start, i);
};
var getPathNoStrict = (request) => {
	const result = getPath(request);
	return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
};
/**
* Merge paths.
* @param {string[]} ...paths - The paths to merge.
* @returns {string} The merged path.
* @example
* mergePath('/api', '/users') // '/api/users'
* mergePath('/api/', '/users') // '/api/users'
* mergePath('/api', '/') // '/api'
* mergePath('/api/', '/') // '/api/'
*/
var mergePath = (base, sub, ...rest) => {
	if (rest.length) sub = mergePath(sub, ...rest);
	return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
};
var checkOptionalParameter = (path) => {
	if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) return null;
	const segments = path.split("/");
	const results = [];
	let basePath = "";
	segments.forEach((segment) => {
		if (segment !== "" && !/\:/.test(segment)) basePath += "/" + segment;
		else if (/\:/.test(segment)) {
			if (segment.charCodeAt(segment.length - 1) === 63) {
				if (results.length === 0 && basePath === "") results.push("/");
				else results.push(basePath);
				const optionalSegment = segment.slice(0, -1);
				basePath += "/" + optionalSegment;
				results.push(basePath);
			} else basePath += "/" + segment;
		}
	});
	return results.filter((v, i, a) => a.indexOf(v) === i);
};
var tryDecodeURIComponent = (str) => str.indexOf("%") !== -1 ? tryDecode(str, decodeURIComponent_) : str;
var _decodeURI = (value) => {
	if (value.indexOf("+") !== -1) value = value.replace(/\+/g, " ");
	return tryDecodeURIComponent(value);
};
var _getQueryParam = (url, key, multiple) => {
	const hashIndex = url.indexOf("#", 8);
	if (hashIndex !== -1) url = url.slice(0, hashIndex);
	let encoded;
	if (!multiple && key && !/[%+&=]/.test(key)) {
		const queryIndex = url.indexOf("?", 8);
		let keyIndex = queryIndex;
		if (keyIndex === -1) return;
		if (!url.startsWith(key, keyIndex + 1)) keyIndex = url.indexOf(`&${key}`, keyIndex + 1);
		while (keyIndex !== -1) {
			const trailingKeyCode = url.charCodeAt(keyIndex + key.length + 1);
			if (trailingKeyCode === 61 || trailingKeyCode === 38 || isNaN(trailingKeyCode)) {
				if (keyIndex > queryIndex && /(?:^|&)[^=&]*[%+]/.test(url.slice(queryIndex + 1, keyIndex))) break;
				if (trailingKeyCode === 61) {
					const valueIndex = keyIndex + key.length + 2;
					const endIndex = url.indexOf("&", valueIndex);
					return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
				}
				return "";
			}
			keyIndex = url.indexOf(`&${key}`, keyIndex + 1);
		}
		encoded = /[%+]/.test(url);
		if (!encoded) return;
	}
	const results = Object.create(null);
	encoded ??= /[%+]/.test(url);
	let keyIndex = url.indexOf("?", 8);
	while (keyIndex !== -1) {
		const nextKeyIndex = url.indexOf("&", keyIndex + 1);
		let valueIndex = url.indexOf("=", keyIndex);
		if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) valueIndex = -1;
		let name = url.slice(keyIndex + 1, valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex);
		if (encoded) name = _decodeURI(name);
		keyIndex = nextKeyIndex;
		if (name === "") continue;
		let value;
		if (valueIndex === -1) value = "";
		else {
			value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
			if (encoded) value = _decodeURI(value);
		}
		if (multiple) {
			if (!(results[name] && Array.isArray(results[name]))) results[name] = [];
			results[name].push(value);
		} else results[name] ??= value;
	}
	return key ? results[key] : results;
};
var getQueryParam = _getQueryParam;
var getQueryParams = (url, key) => {
	return _getQueryParam(url, key, true);
};
var decodeURIComponent_ = decodeURIComponent;
// node_modules/hono/dist/request.js
var HonoRequest = class {
	/**
	* `.raw` can get the raw Request object.
	*
	* @see {@link https://hono.dev/docs/api/request#raw}
	*
	* @example
	* ```ts
	* // For Cloudflare Workers
	* app.post('/', async (c) => {
	*   const metadata = c.req.raw.cf?.hostMetadata?
	*   ...
	* })
	* ```
	*/
	raw;
	#validatedData;
	#matchResult;
	routeIndex = 0;
	/**
	* `.path` can get the pathname of the request.
	*
	* @see {@link https://hono.dev/docs/api/request#path}
	*
	* @example
	* ```ts
	* app.get('/about/me', (c) => {
	*   const pathname = c.req.path // `/about/me`
	* })
	* ```
	*/
	path;
	bodyCache = {};
	constructor(request, path = "/", matchResult = [[]]) {
		this.raw = request;
		this.path = path;
		this.#matchResult = matchResult;
	}
	param(key) {
		return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
	}
	#getDecodedParam(key) {
		const paramKey = this.#matchResult[0][this.routeIndex]?.[1][key];
		const param = this.#getParamValue(paramKey);
		return param && tryDecodeURIComponent(param);
	}
	#getAllDecodedParams() {
		const decoded = {};
		const keys = Object.keys(this.#matchResult[0][this.routeIndex]?.[1] ?? {});
		for (const key of keys) {
			const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
			if (value !== void 0) decoded[key] = tryDecodeURIComponent(value);
		}
		return decoded;
	}
	#getParamValue(paramKey) {
		return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
	}
	query(key) {
		return getQueryParam(this.url, key);
	}
	queries(key) {
		return getQueryParams(this.url, key);
	}
	header(name) {
		if (name) return this.raw.headers.get(name) ?? void 0;
		const headerData = Object.create(null);
		this.raw.headers.forEach((value, key) => {
			headerData[key] = value;
		});
		return headerData;
	}
	async parseBody(options) {
		return parseBody$1(this, options);
	}
	#cachedBody = (key) => {
		const { bodyCache, raw } = this;
		const cachedBody = bodyCache[key];
		if (cachedBody) return cachedBody;
		for (const anyCachedKey in bodyCache) return bodyCache[anyCachedKey].then((body) => {
			if (anyCachedKey === "json") body = JSON.stringify(body);
			const contentType = anyCachedKey === "formData" ? void 0 : raw.headers.get("content-type");
			return new Response(body, { headers: contentType ? { "Content-Type": contentType } : void 0 })[key]();
		});
		return bodyCache[key] = raw[key]();
	};
	/**
	* `.json()` can parse Request body of type `application/json`
	*
	* @see {@link https://hono.dev/docs/api/request#json}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.json()
	* })
	* ```
	*/
	json() {
		return this.#cachedBody("text").then((text) => JSON.parse(text));
	}
	/**
	* `.text()` can parse Request body of type `text/plain`
	*
	* @see {@link https://hono.dev/docs/api/request#text}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.text()
	* })
	* ```
	*/
	text() {
		return this.#cachedBody("text");
	}
	/**
	* `.arrayBuffer()` parse Request body as an `ArrayBuffer`
	*
	* @see {@link https://hono.dev/docs/api/request#arraybuffer}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.arrayBuffer()
	* })
	* ```
	*/
	arrayBuffer() {
		return this.#cachedBody("arrayBuffer");
	}
	/**
	* `.bytes()` parses the request body as a `Uint8Array`.
	*
	* @see {@link https://hono.dev/docs/api/request#bytes}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.bytes()
	* })
	* ```
	*/
	bytes() {
		return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
	}
	/**
	* Parses the request body as a `Blob`.
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.blob();
	* });
	* ```
	* @see https://hono.dev/docs/api/request#blob
	*/
	blob() {
		return this.#cachedBody("blob");
	}
	/**
	* Parses the request body as `FormData`.
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.formData();
	* });
	* ```
	* @see https://hono.dev/docs/api/request#formdata
	*/
	formData() {
		return this.#cachedBody("formData");
	}
	/**
	* Adds validated data to the request.
	*
	* @param target - The target of the validation.
	* @param data - The validated data to add.
	*/
	addValidatedData(target, data) {
		(this.#validatedData ??= {})[target] = data;
	}
	valid(target) {
		return this.#validatedData?.[target];
	}
	/**
	* `.url` can get the request url strings.
	*
	* @see {@link https://hono.dev/docs/api/request#url}
	*
	* @example
	* ```ts
	* app.get('/about/me', (c) => {
	*   const url = c.req.url // `http://localhost:8787/about/me`
	*   ...
	* })
	* ```
	*/
	get url() {
		return this.raw.url;
	}
	/**
	* `.method` can get the method name of the request.
	*
	* @see {@link https://hono.dev/docs/api/request#method}
	*
	* @example
	* ```ts
	* app.get('/about/me', (c) => {
	*   const method = c.req.method // `GET`
	* })
	* ```
	*/
	get method() {
		return this.raw.method;
	}
	get [GET_MATCH_RESULT]() {
		return this.#matchResult;
	}
	/**
	* `.matchedRoutes` can return a matched route in the handler
	*
	* @deprecated
	*
	* Use matchedRoutes helper defined in "hono/route" instead.
	*
	* @see {@link https://hono.dev/docs/api/request#matchedroutes}
	*
	* @example
	* ```ts
	* app.use('*', async function logger(c, next) {
	*   await next()
	*   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
	*     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
	*     console.log(
	*       method,
	*       ' ',
	*       path,
	*       ' '.repeat(Math.max(10 - path.length, 0)),
	*       name,
	*       i === c.req.routeIndex ? '<- respond from here' : ''
	*     )
	*   })
	* })
	* ```
	*/
	get matchedRoutes() {
		return this.#matchResult[0].map(([[, route]]) => route);
	}
	/**
	* `.routePath` can retrieve the path registered within the handler
	*
	* @deprecated
	*
	* Use routePath helper defined in "hono/route" instead.
	*
	* @see {@link https://hono.dev/docs/api/request#routepath}
	*
	* @example
	* ```ts
	* app.get('/posts/:id', (c) => {
	*   return c.json({ path: c.req.routePath })
	* })
	* ```
	*/
	get routePath() {
		return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
	}
};
// node_modules/hono/dist/utils/html.js
/**
* @module
* HTML utility.
*/
var HtmlEscapedCallbackPhase = {
	Stringify: 1,
	BeforeStream: 2,
	Stream: 3
};
var raw = (value, callbacks) => {
	const escapedString = new String(value);
	escapedString.isEscaped = true;
	escapedString.callbacks = callbacks;
	return escapedString;
};
var resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
	if (typeof str === "object" && !(str instanceof String)) {
		if (!(str instanceof Promise)) str = str.toString();
		if (str instanceof Promise) str = await str;
	}
	const callbacks = str.callbacks;
	if (!callbacks?.length) return Promise.resolve(str);
	if (buffer) buffer[0] += str;
	else buffer = [str];
	const resStr = Promise.all(callbacks.map((c) => c({
		phase,
		buffer,
		context
	}))).then((res) => Promise.all(res.filter(Boolean).map((str) => resolveCallback(str, phase, false, context, buffer))).then(() => buffer[0]));
	if (preserveCallbacks) return raw(await resStr, callbacks);
	else return resStr;
};
// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = (contentType, headers) => {
	return {
		"Content-Type": contentType,
		...headers
	};
};
var createResponseInstance = (body, init) => new Response(body, init);
var Context = class {
	#rawRequest;
	#req;
	/**
	* `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
	*
	* @see {@link https://hono.dev/docs/api/context#env}
	*
	* @example
	* ```ts
	* // Environment object for Cloudflare Workers
	* app.get('*', async c => {
	*   const counter = c.env.COUNTER
	* })
	* ```
	*/
	env = {};
	#var;
	finalized = false;
	/**
	* `.error` can get the error object from the middleware if the Handler throws an error.
	*
	* @see {@link https://hono.dev/docs/api/context#error}
	*
	* @example
	* ```ts
	* app.use('*', async (c, next) => {
	*   await next()
	*   if (c.error) {
	*     // do something...
	*   }
	* })
	* ```
	*/
	error;
	#status;
	#executionCtx;
	#res;
	#layout;
	#renderer;
	#notFoundHandler;
	#preparedHeaders;
	#matchResult;
	#path;
	/**
	* Creates an instance of the Context class.
	*
	* @param req - The Request object.
	* @param options - Optional configuration options for the context.
	*/
	constructor(req, options) {
		this.#rawRequest = req;
		if (options) {
			this.#executionCtx = options.executionCtx;
			this.env = options.env;
			this.#notFoundHandler = options.notFoundHandler;
			this.#path = options.path;
			this.#matchResult = options.matchResult;
		}
	}
	/**
	* `.req` is the instance of {@link HonoRequest}.
	*/
	get req() {
		this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
		return this.#req;
	}
	/**
	* @see {@link https://hono.dev/docs/api/context#event}
	* The FetchEvent associated with the current request.
	*
	* @throws Will throw an error if the context does not have a FetchEvent.
	*/
	get event() {
		if (this.#executionCtx && "respondWith" in this.#executionCtx) return this.#executionCtx;
		else throw Error("This context has no FetchEvent");
	}
	/**
	* @see {@link https://hono.dev/docs/api/context#executionctx}
	* The ExecutionContext associated with the current request.
	*
	* @throws Will throw an error if the context does not have an ExecutionContext.
	*/
	get executionCtx() {
		if (this.#executionCtx) return this.#executionCtx;
		else throw Error("This context has no ExecutionContext");
	}
	/**
	* @see {@link https://hono.dev/docs/api/context#res}
	* The Response object for the current request.
	*/
	get res() {
		return this.#res ||= createResponseInstance(null, { headers: this.#preparedHeaders ??= new Headers() });
	}
	/**
	* Sets the Response object for the current request.
	*
	* @param _res - The Response object to set.
	*/
	set res(_res) {
		if (this.#res && _res) {
			_res = createResponseInstance(_res.body, _res);
			for (const [k, v] of this.#res.headers.entries()) {
				if (k === "content-type") continue;
				if (k === "set-cookie") {
					const cookies = this.#res.headers.getSetCookie();
					_res.headers.delete("set-cookie");
					for (const cookie of cookies) _res.headers.append("set-cookie", cookie);
				} else _res.headers.set(k, v);
			}
		}
		this.#res = _res;
		this.finalized = true;
	}
	/**
	* `.render()` can create a response within a layout.
	*
	* @see {@link https://hono.dev/docs/api/context#render-setrenderer}
	*
	* @example
	* ```ts
	* app.get('/', (c) => {
	*   return c.render('Hello!')
	* })
	* ```
	*/
	render = (...args) => {
		this.#renderer ??= (content) => this.html(content);
		return this.#renderer(...args);
	};
	/**
	* Sets the layout for the response.
	*
	* @param layout - The layout to set.
	* @returns The layout function.
	*/
	setLayout = (layout) => this.#layout = layout;
	/**
	* Gets the current layout for the response.
	*
	* @returns The current layout function.
	*/
	getLayout = () => this.#layout;
	/**
	* `.setRenderer()` can set the layout in the custom middleware.
	*
	* @see {@link https://hono.dev/docs/api/context#render-setrenderer}
	*
	* @example
	* ```tsx
	* app.use('*', async (c, next) => {
	*   c.setRenderer((content) => {
	*     return c.html(
	*       <html>
	*         <body>
	*           <p>{content}</p>
	*         </body>
	*       </html>
	*     )
	*   })
	*   await next()
	* })
	* ```
	*/
	setRenderer = (renderer) => {
		this.#renderer = renderer;
	};
	/**
	* `.header()` can set headers.
	*
	* @see {@link https://hono.dev/docs/api/context#header}
	*
	* @example
	* ```ts
	* app.get('/welcome', (c) => {
	*   // Set headers
	*   c.header('X-Message', 'Hello!')
	*   c.header('Content-Type', 'text/plain')
	*
	*   // Append multiple headers using the append option (e.g. Vary)
	*   c.header('Vary', 'Accept-Encoding', { append: true })
	*   c.header('Vary', 'User-Agent', { append: true })
	*
	*   return c.body('Thank you for coming')
	* })
	* ```
	*/
	header = (name, value, options) => {
		if (this.finalized && !this.#res.bodyUsed) this.#res = createResponseInstance(this.#res.body, this.#res);
		const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
		if (value === void 0) headers.delete(name);
		else if (options?.append) headers.append(name, value);
		else headers.set(name, value);
	};
	status = (status) => {
		this.#status = status;
	};
	/**
	* `.set()` can set the value specified by the key.
	*
	* @see {@link https://hono.dev/docs/api/context#set-get}
	*
	* @example
	* ```ts
	* app.use('*', async (c, next) => {
	*   c.set('message', 'Hono is hot!!')
	*   await next()
	* })
	* ```
	*/
	set = (key, value) => {
		this.#var ??= /* @__PURE__ */ new Map();
		this.#var.set(key, value);
	};
	/**
	* `.get()` can use the value specified by the key.
	*
	* @see {@link https://hono.dev/docs/api/context#set-get}
	*
	* @example
	* ```ts
	* app.get('/', (c) => {
	*   const message = c.get('message')
	*   return c.text(`The message is "${message}"`)
	* })
	* ```
	*/
	get = (key) => {
		return this.#var ? this.#var.get(key) : void 0;
	};
	/**
	* `.var` can access the value of a variable.
	*
	* @see {@link https://hono.dev/docs/api/context#var}
	*
	* @example
	* ```ts
	* const result = c.var.client.oneMethod()
	* ```
	*/
	get var() {
		if (!this.#var) return {};
		return Object.fromEntries(this.#var);
	}
	#newResponse(data, arg, headers) {
		let responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders;
		if (typeof arg === "object" && arg.headers) {
			responseHeaders ??= new Headers();
			for (const [key, value] of new Headers(arg.headers)) if (key === "set-cookie") responseHeaders.append(key, value);
			else responseHeaders.set(key, value);
		}
		if (headers) {
			if (!responseHeaders) {
				let count = 0;
				for (const k in headers) if (++count > 1 || typeof headers[k] !== "string") {
					responseHeaders = new Headers();
					break;
				}
			}
			if (responseHeaders) for (const k in headers) {
				const v = headers[k];
				if (typeof v === "string") responseHeaders.set(k, v);
				else {
					responseHeaders.delete(k);
					for (const v2 of v) responseHeaders.append(k, v2);
				}
			}
		}
		return createResponseInstance(data, {
			status: typeof arg === "number" ? arg : arg?.status ?? this.#status,
			headers: responseHeaders ?? headers
		});
	}
	newResponse = (...args) => this.#newResponse(...args);
	/**
	* `.body()` can return the HTTP response.
	* You can set headers with `.header()` and set HTTP status code with `.status`.
	* This can also be set in `.text()`, `.json()` and so on.
	*
	* @see {@link https://hono.dev/docs/api/context#body}
	*
	* @example
	* ```ts
	* app.get('/welcome', (c) => {
	*   // Set headers
	*   c.header('X-Message', 'Hello!')
	*   c.header('Content-Type', 'text/plain')
	*   // Set HTTP status code
	*   c.status(201)
	*
	*   // Return the response body
	*   return c.body('Thank you for coming')
	* })
	* ```
	*/
	body = (data, arg, headers) => this.#newResponse(data, arg, headers);
	/**
	* `.text()` can render text as `Content-Type:text/plain`.
	*
	* @see {@link https://hono.dev/docs/api/context#text}
	*
	* @example
	* ```ts
	* app.get('/say', (c) => {
	*   return c.text('Hello!')
	* })
	* ```
	*/
	text = (text, arg, headers) => {
		return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers));
	};
	/**
	* `.json()` can render JSON as `Content-Type:application/json`.
	*
	* @see {@link https://hono.dev/docs/api/context#json}
	*
	* @example
	* ```ts
	* app.get('/api', (c) => {
	*   return c.json({ message: 'Hello!' })
	* })
	* ```
	*/
	json = (object, arg, headers) => {
		return this.#newResponse(JSON.stringify(object), arg, setDefaultContentType("application/json", headers));
	};
	html = (html, arg, headers) => {
		const res = (html) => this.#newResponse(html, arg, setDefaultContentType("text/html; charset=UTF-8", headers));
		return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
	};
	/**
	* `.redirect()` can Redirect, default status code is 302.
	*
	* @see {@link https://hono.dev/docs/api/context#redirect}
	*
	* @example
	* ```ts
	* app.get('/redirect', (c) => {
	*   return c.redirect('/')
	* })
	* app.get('/redirect-permanently', (c) => {
	*   return c.redirect('/', 301)
	* })
	* ```
	*/
	redirect = (location, status) => {
		const locationString = String(location);
		this.header("Location", !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString));
		return this.newResponse(null, status ?? 302);
	};
	/**
	* `.notFound()` can return the Not Found Response.
	*
	* @see {@link https://hono.dev/docs/api/context#notfound}
	*
	* @example
	* ```ts
	* app.get('/notfound', (c) => {
	*   return c.notFound()
	* })
	* ```
	*/
	notFound = () => {
		this.#notFoundHandler ??= () => createResponseInstance();
		return this.#notFoundHandler(this);
	};
};
// node_modules/hono/dist/compose.js
/**
* Compose middleware functions into a single function based on `koa-compose` package.
*
* @template E - The environment type.
*
* @param {[[Function, unknown], unknown][] | [[Function]][]} middleware - An array of middleware functions and their corresponding parameters.
* @param {ErrorHandler<E>} [onError] - An optional error handler function.
* @param {NotFoundHandler<E>} [onNotFound] - An optional not-found handler function.
*
* @returns {(context: Context, next?: Next) => Promise<Context>} - A composed middleware function.
*/
var compose = (middleware, onError, onNotFound) => {
	return (context, next) => {
		let index = -1;
		return dispatch(0);
		/**
		* Dispatch the middleware functions.
		*
		* @param {number} i - The current index in the middleware array.
		*
		* @returns {Promise<Context>} - A promise that resolves to the context.
		*/
		async function dispatch(i) {
			if (i <= index) throw new Error("next() called multiple times");
			index = i;
			let res;
			let isError = false;
			let handler;
			if (middleware[i]) {
				handler = middleware[i][0][0];
				context.req.routeIndex = i;
			} else handler = i === middleware.length && next || void 0;
			if (handler) try {
				res = await handler(context, () => dispatch(i + 1));
			} catch (err) {
				if (err instanceof Error && onError) {
					context.error = err;
					res = await onError(err, context);
					isError = true;
				} else throw err;
			}
			else if (context.finalized === false && onNotFound) res = await onNotFound(context);
			if (res && (context.finalized === false || isError)) context.res = res;
			return context;
		}
	};
};
// node_modules/hono/dist/helper/route/index.js
/**
* Get matched routes in the handler
*
* @param {Context} c - The context object
* @returns An array of matched routes
*
* @example
* ```ts
* import { matchedRoutes } from 'hono/route'
*
* app.use('*', async function logger(c, next) {
*   await next()
*   matchedRoutes(c).forEach(({ handler, method, path }, i) => {
*     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
*     console.log(
*       method,
*       ' ',
*       path,
*       ' '.repeat(Math.max(10 - path.length, 0)),
*       name,
*       i === c.req.routeIndex ? '<- respond from here' : ''
*     )
*   })
* })
* ```
*/
var matchedRoutes = (c) => c.req[GET_MATCH_RESULT][0].map(([[, route]]) => route);
/**
* Get the route path registered within the handler
*
* @param {Context} c - The context object
* @param {number} index - The index of the route from which to retrieve the path, similar to Array.prototype.at(), where a negative number is the index counted from the end of the matching route. Defaults to the current route index.
* @returns The route path registered within the handler
*
* @example
* ```ts
* import { routePath } from 'hono/route'
*
* app.use('*', (c, next) => {
*   console.log(routePath(c)) // '*'
*   console.log(routePath(c, -1)) // '/posts/:id'
*   return next()
* })
*
* app.get('/posts/:id', (c) => {
*   return c.text(routePath(c)) // '/posts/:id'
* })
* ```
*/
var routePath = (c, index) => matchedRoutes(c).at(index ?? c.req.routeIndex)?.path ?? "";
// node_modules/hono/dist/router.js
/**
* Array of supported HTTP methods.
*/
var METHODS = [
	"get",
	"post",
	"put",
	"delete",
	"options",
	"patch",
	"query"
];
/**
* Error message indicating that a route cannot be added because the matcher is already built.
*/
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
/**
* Error class representing an unsupported path error.
*/
var UnsupportedPathError = class extends Error {};
// node_modules/hono/dist/utils/constants.js
/**
* Constant used to mark a composed handler.
*/
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";
// node_modules/hono/dist/utils/mount.js
var countTrailingSlashes = (path) => {
	let index = path.length;
	while (index > 0 && path.charCodeAt(index - 1) === 47) index--;
	return path.length - index;
};
var getPathPrefixLength = (c, pathPrefix, routePath) => {
	if (!/[:*]/.test(pathPrefix)) return pathPrefix.length;
	const path = c.req.path;
	const matchResult = c.req[GET_MATCH_RESULT];
	const paramNames = /* @__PURE__ */ new Set();
	let length = 0;
	for (const part of splitRoutingPath(pathPrefix)) {
		if (part[0] === ":" && part.endsWith("}?")) throw new Error(`mount(): Optional regular expression parameters are not supported in "${routePath}".`);
		const pattern = getPattern(part);
		if (pattern && pattern !== "*") {
			const name = pattern[1];
			if (paramNames.has(name)) throw new Error(`mount(): Duplicate path parameter "${name}" in "${routePath}".`);
			paramNames.add(name);
		}
		if (pattern && pattern !== "*" && pattern[2] !== true) {
			const value = matchResult.length === 2 ? matchResult[1][matchResult[0][c.req.routeIndex][1][pattern[1]]] : matchResult[0][c.req.routeIndex][1][pattern[1]];
			length += value.length + 1;
		} else if (pattern || part.endsWith("*")) {
			const end = path.indexOf("/", length + 1);
			length = end === -1 ? path.length : end;
		} else length += part.length + 1;
	}
	return length;
};
var createMountedRequest = (c, pathPrefix, routePath) => {
	if (/[^/]\*$/.test(routePath)) throw new Error(`mount(): Wildcard must follow "/" in "${routePath}".`);
	const prefixLength = getPathPrefixLength(c, pathPrefix, routePath);
	const path = c.req.path.slice(prefixLength) || "/";
	if (prefixLength > c.req.path.length || path[0] !== "/" || /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(path)) throw new HTTPException(400, { message: "Invalid mounted path" });
	const rawUrl = c.req.raw.url;
	if (/^[^/?#]*\/\/[^/?#\\]*[?#\\]/.test(rawUrl)) throw new HTTPException(400, { message: "Invalid mounted path" });
	const rawPathEnd = rawUrl.search(/[?#]/);
	const rawTrailingSlashes = countTrailingSlashes(rawPathEnd === -1 ? rawUrl : rawUrl.slice(0, rawPathEnd));
	if (rawTrailingSlashes > 1 && countTrailingSlashes(c.req.path) === rawTrailingSlashes - 1) throw new HTTPException(400, { message: "Invalid mounted path" });
	const url = new URL(rawUrl);
	url.pathname = path.replace(/[\\\t\n\r]/g, encodeURIComponent);
	if (path.includes("%")) {}
	return new Request(url, c.req.raw);
};
// node_modules/hono/dist/hono-base.js
/**
* @module
* This module is the base module for the Hono object.
*/
var notFoundHandler = (c) => {
	return c.text("404 Not Found", 404);
};
var errorHandler = (err, c) => {
	if ("getResponse" in err) {
		const res = err.getResponse();
		return c.newResponse(res.body, res);
	}
	console.error(err);
	return c.text("Internal Server Error", 500);
};
var Hono$1 = class Hono {
	get;
	post;
	put;
	delete;
	options;
	patch;
	query;
	all;
	on;
	use;
	router;
	getPath;
	_basePath = "/";
	#path = "/";
	routes = [];
	constructor(options = {}) {
		[...METHODS, "all"].forEach((method) => {
			this[method] = (args1, ...args) => {
				const methodName = method.toUpperCase();
				if (typeof args1 === "string") this.#path = args1;
				else this.#addRoute(methodName, this.#path, args1);
				args.forEach((handler) => {
					this.#addRoute(methodName, this.#path, handler);
				});
				return this;
			};
		});
		this.on = (method, path, ...handlers) => {
			for (const p of [path].flat()) {
				this.#path = p;
				for (const m of [method].flat()) {
					const methodName = m.toUpperCase();
					for (const handler of handlers) this.#addRoute(methodName, this.#path, handler);
				}
			}
			return this;
		};
		this.use = (arg1, ...handlers) => {
			if (typeof arg1 === "string") this.#path = arg1;
			else {
				this.#path = "*";
				handlers.unshift(arg1);
			}
			handlers.forEach((handler) => {
				this.#addRoute("ALL", this.#path, handler);
			});
			return this;
		};
		const { strict, ...optionsWithoutStrict } = options;
		Object.assign(this, optionsWithoutStrict);
		this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
	}
	#clone() {
		const clone = new Hono({
			router: this.router,
			getPath: this.getPath
		});
		clone.errorHandler = this.errorHandler;
		clone.#notFoundHandler = this.#notFoundHandler;
		clone.routes = this.routes;
		return clone;
	}
	#notFoundHandler = notFoundHandler;
	errorHandler = errorHandler;
	/**
	* `.route()` allows grouping other Hono instance in routes.
	*
	* @see {@link https://hono.dev/docs/api/routing#grouping}
	*
	* @param {string} path - base Path
	* @param {Hono} app - other Hono instance
	* @returns {Hono} routed Hono instance
	*
	* @example
	* ```ts
	* const app = new Hono()
	* const app2 = new Hono()
	*
	* app2.get("/user", (c) => c.text("user"))
	* app.route("/api", app2) // GET /api/user
	* ```
	*/
	route(path, app) {
		const subApp = this.basePath(path);
		app.routes.map((r) => {
			let handler;
			if (app.errorHandler === errorHandler) handler = r.handler;
			else {
				handler = async (c, next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res;
				handler[COMPOSED_HANDLER] = r.handler;
			}
			subApp.#addRoute(r.method, r.path, handler, r.basePath);
		});
		return this;
	}
	/**
	* `.basePath()` allows base paths to be specified.
	*
	* @see {@link https://hono.dev/docs/api/routing#base-path}
	*
	* @param {string} path - base Path
	* @returns {Hono} changed Hono instance
	*
	* @example
	* ```ts
	* const api = new Hono().basePath('/api')
	* ```
	*/
	basePath(path) {
		const subApp = this.#clone();
		subApp._basePath = mergePath(this._basePath, path);
		return subApp;
	}
	/**
	* `.onError()` handles an error and returns a customized Response.
	*
	* @see {@link https://hono.dev/docs/api/hono#error-handling}
	*
	* @param {ErrorHandler} handler - request Handler for error
	* @returns {Hono} changed Hono instance
	*
	* @example
	* ```ts
	* app.onError((err, c) => {
	*   console.error(`${err}`)
	*   return c.text('Custom Error Message', 500)
	* })
	* ```
	*/
	onError = (handler) => {
		this.errorHandler = handler;
		return this;
	};
	/**
	* `.notFound()` allows you to customize a Not Found Response.
	*
	* @see {@link https://hono.dev/docs/api/hono#not-found}
	*
	* @param {NotFoundHandler} handler - request handler for not-found
	* @returns {Hono} changed Hono instance
	*
	* @example
	* ```ts
	* app.notFound((c) => {
	*   return c.text('Custom 404 Message', 404)
	* })
	* ```
	*/
	notFound = (handler) => {
		this.#notFoundHandler = handler;
		return this;
	};
	/**
	* `.mount()` allows you to mount applications built with other frameworks into your Hono application.
	*
	* @deprecated Use `mount()` from `hono/mount` instead. `.mount()` will be removed in v5.
	*
	* @see {@link https://hono.dev/docs/api/hono#mount}
	*
	* @param {string} path - base Path
	* @param {Function} applicationHandler - other Request Handler
	* @param {MountOptions} [options] - options of `.mount()`
	* @returns {Hono} mounted Hono instance
	* @throws {Error} If automatic request rewriting encounters duplicate path parameter names or an optional regular expression parameter.
	* @throws {HTTPException} With status 400 if automatic request rewriting cannot safely preserve the routed path.
	*
	* @example
	* ```ts
	* import { Router as IttyRouter } from 'itty-router'
	* import { Hono } from 'hono'
	* // Create itty-router application
	* const ittyRouter = IttyRouter()
	* // GET /itty-router/hello
	* ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
	*
	* const app = new Hono()
	* app.mount('/itty-router', ittyRouter.handle)
	* ```
	*
	* @example
	* ```ts
	* const app = new Hono()
	* // Send the request to another application without modification.
	* app.mount('/app', anotherApp, {
	*   replaceRequest: (req) => req,
	* })
	* ```
	*/
	mount(path, applicationHandler, options) {
		let replaceRequest;
		let optionHandler;
		if (options) {
			if (typeof options === "function") optionHandler = options;
			else {
				optionHandler = options.optionHandler;
				if (options.replaceRequest === false) replaceRequest = (request) => request;
				else replaceRequest = options.replaceRequest;
			}
		}
		const getOptions = optionHandler ? (c) => {
			const options = optionHandler(c);
			return Array.isArray(options) ? options : [options];
		} : (c) => {
			let executionContext = void 0;
			try {
				executionContext = c.executionCtx;
			} catch {}
			return [c.env, executionContext];
		};
		const defaultReplaceRequest = (c) => {
			const mountedRoutePath = routePath(c);
			return createMountedRequest(c, mountedRoutePath.replace(/\/?\*$/, ""), mountedRoutePath);
		};
		const handler = async (c, next) => {
			const res = await applicationHandler(replaceRequest ? replaceRequest(c.req.raw) : defaultReplaceRequest(c), ...getOptions(c));
			if (res) return res;
			await next();
		};
		this.#addRoute("ALL", mergePath(path, "*"), handler);
		return this;
	}
	#addRoute(method, path, handler, baseRoutePath) {
		path = mergePath(this._basePath, path);
		const r = {
			basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
			path,
			method,
			handler
		};
		this.router.add(method, path, [handler, r]);
		this.routes.push(r);
	}
	#handleError(err, c) {
		if (err instanceof Error) return this.errorHandler(err, c);
		throw err;
	}
	#dispatch(request, executionCtx, env, method) {
		if (method === "HEAD") return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
		const path = this.getPath(request, { env });
		const matchResult = this.router.match(method, path);
		const c = new Context(request, {
			path,
			matchResult,
			env,
			executionCtx,
			notFoundHandler: this.#notFoundHandler
		});
		if (matchResult[0].length === 1) {
			let res;
			try {
				res = matchResult[0][0][0][0](c, async () => {
					c.res = await this.#notFoundHandler(c);
				});
			} catch (err) {
				return this.#handleError(err, c);
			}
			return res instanceof Promise ? res.then((resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
		}
		const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
		return (async () => {
			try {
				const context = await composed(c);
				if (!context.finalized) throw new Error("Context is not finalized. Did you forget to return a Response object or `await next()`?");
				return context.res;
			} catch (err) {
				return this.#handleError(err, c);
			}
		})();
	}
	/**
	* `.fetch()` will be entry point of your app.
	*
	* @see {@link https://hono.dev/docs/api/hono#fetch}
	*
	* @param {Request} request - request Object of request
	* @param {Env} env - env Object
	* @param {ExecutionContext} executionCtx - context of execution
	* @returns {Response | Promise<Response>} response of request
	*
	*/
	fetch = (request, ...rest) => {
		return this.#dispatch(request, rest[1], rest[0], request.method);
	};
	/**
	* `.request()` is a useful method for testing.
	* You can pass a URL or pathname to send a GET request.
	* app will return a Response object.
	* ```ts
	* test('GET /hello is ok', async () => {
	*   const res = await app.request('/hello')
	*   expect(res.status).toBe(200)
	* })
	* ```
	* @see https://hono.dev/docs/api/hono#request
	*/
	request = (input, requestInit, Env, executionCtx) => {
		if (input instanceof Request) return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
		input = input.toString();
		return this.fetch(new Request(/^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`, requestInit), Env, executionCtx);
	};
	/**
	* `.fire()` automatically adds a global fetch event listener.
	* This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
	* @deprecated
	* Use `fire` from `hono/service-worker` instead.
	* ```ts
	* import { Hono } from 'hono'
	* import { fire } from 'hono/service-worker'
	*
	* const app = new Hono()
	* // ...
	* fire(app)
	* ```
	* @see https://hono.dev/docs/api/hono#fire
	* @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
	* @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
	*/
	fire = () => {
		addEventListener("fetch", (event) => {
			event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
		});
	};
};
// node_modules/hono/dist/router/utils.js
var createNullObject = () => Object.create(null);
// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
	const matchers = this.buildAllMatchers();
	const match = ((method, path) => {
		const matcher = matchers[method] || matchers["ALL"];
		const staticMatch = matcher[2][path];
		if (staticMatch) return staticMatch;
		const match = path.match(matcher[0]);
		if (!match) return [[], emptyParam];
		const index = match.indexOf("", 1);
		return [matcher[1][index], match];
	});
	this.match = match;
	return match(method, path);
}
// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = "[^]*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/[^]*)";
var PATH_ERROR = Symbol();
var regExpMetaChars = /* @__PURE__ */ new Set(".\\+*[^]$()");
/**
* Sort order:
* 1. literal
* 2. special pattern (e.g. :label{[0-9]+})
* 3. common label pattern (e.g. :label)
* 4. wildcard
*/
function compareKey(a, b) {
	if (a.length === 1) return b.length === 1 ? a < b ? -1 : 1 : -1;
	if (b.length === 1) return 1;
	if (a === "[^]*" || a === "(?:|/[^]*)") return b === "[^]*" ? -1 : 1;
	else if (b === "[^]*" || b === "(?:|/[^]*)") return -1;
	if (a === "[^/]+") return 1;
	else if (b === "[^/]+") return -1;
	return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
var Node$1 = class Node {
	#index;
	#varIndex;
	#children = createNullObject();
	insert(tokens, index, paramMap, context, keys) {
		let node = this;
		for (let i = 0, len = tokens.length; i < len; i++) {
			const token = tokens[i];
			const pattern = token.length === 1 ? token === "*" ? i === len - 1 ? [
				"",
				"",
				ONLY_WILDCARD_REG_EXP_STR
			] : [
				"",
				"",
				LABEL_REG_EXP_STR
			] : null : token === "/*" ? [
				"",
				"",
				TAIL_WILDCARD_REG_EXP_STR
			] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
			let nextNode;
			if (pattern) {
				const name = pattern[1];
				let regexpStr = pattern[2] || "[^/]+";
				if (name && pattern[2]) {
					if (new RegExp(regexpStr).test("")) throw PATH_ERROR;
					regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
					if (/\((?!\?:)/.test(regexpStr)) throw PATH_ERROR;
					if (regexpStr.length === 1 && regExpMetaChars.has(regexpStr)) throw PATH_ERROR;
				}
				keys.push(regexpStr);
				nextNode = node.#children[regexpStr];
				if (!nextNode) {
					if (regexpStr !== "[^]*" && regexpStr !== "(?:|/[^]*)") {
						for (const k in node.#children) if ((regexpStr.length > 1 || k.length > 1) && k !== "[^]*" && k !== "(?:|/[^]*)") throw PATH_ERROR;
					}
					nextNode = node.#children[regexpStr] = new Node();
				}
				if (name !== "") {
					nextNode.#varIndex ??= context.varIndex++;
					paramMap.push([name, nextNode.#varIndex]);
				}
			} else {
				keys.push(token);
				nextNode = node.#children[token];
				if (!nextNode) {
					for (const k in node.#children) if (k.length > 1 && k !== "[^]*" && k !== "(?:|/[^]*)") throw PATH_ERROR;
					nextNode = node.#children[token] = new Node();
				}
			}
			node = nextNode;
		}
		if (node.#index !== void 0) throw PATH_ERROR;
		node.#index = index;
	}
	buildRegExpStr() {
		const strList = Object.keys(this.#children).sort(compareKey).map((k) => {
			const c = this.#children[k];
			const childStr = c.buildRegExpStr();
			return childStr === "" ? "" : (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + childStr;
		}).filter(Boolean);
		if (typeof this.#index === "number" && this.#index !== -1) strList.unshift(`#${this.#index}`);
		if (strList.length === 0) return "";
		if (strList.length === 1) return strList[0];
		return "(?:" + strList.join("|") + ")";
	}
};
// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
	#context = { varIndex: 0 };
	#root = new Node$1();
	#index = 0;
	paths = createNullObject();
	insert(path, isStatic) {
		const keys = [];
		if (isStatic) {
			this.#root.insert(path.split(""), -1, [], this.#context, keys);
			this.paths[path] = [
				-1,
				[],
				keys
			];
			return;
		}
		const paramAssoc = [];
		const groups = [];
		let markedPath = path;
		for (let i = 0;;) {
			let replaced = false;
			markedPath = markedPath.replace(/\{(?:\{[\d,]+\}|[^}])+\}/g, (m) => {
				const mark = `@\\${i}`;
				groups[i] = [mark, m];
				i++;
				replaced = true;
				return mark;
			});
			if (!replaced) break;
		}
		/**
		*  - pattern (:label, :label{0-9]+}, ...)
		*  - /* wildcard
		*  - character
		*/
		const tokens = markedPath.match(/(?::[^\/]+)|(?:\/\*$)|./gs) || [];
		for (let i = groups.length - 1; i >= 0; i--) {
			const [mark] = groups[i];
			for (let j = tokens.length - 1; j >= 0; j--) if (tokens[j].indexOf(mark) !== -1) {
				tokens[j] = tokens[j].replace(mark, groups[i][1]);
				break;
			}
		}
		this.#root.insert(tokens, this.#index, paramAssoc, this.#context, keys);
		this.paths[path] = [
			this.#index++,
			paramAssoc,
			keys
		];
	}
	buildRegExp() {
		let regexp = this.#root.buildRegExpStr();
		if (regexp === "") return [
			/^$/,
			[],
			[]
		];
		let captureIndex = 0;
		const indexReplacementMap = [];
		const paramReplacementMap = [];
		regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
			if (handlerIndex !== void 0) {
				indexReplacementMap[++captureIndex] = Number(handlerIndex);
				return "$()";
			}
			if (paramIndex !== void 0) {
				paramReplacementMap[Number(paramIndex)] = ++captureIndex;
				return "";
			}
			return "";
		});
		return [
			new RegExp(`^${regexp}`),
			indexReplacementMap,
			paramReplacementMap
		];
	}
};
// node_modules/hono/dist/router/reg-exp-router/router.js
function endsWithWildcard(keys) {
	const tail = keys[keys.length - 1];
	return tail === "[^]*" || tail === "(?:|/[^]*)";
}
function covers(wildcard, target) {
	const last = wildcard.length - 1;
	for (let i = 0; i < last; i++) if (wildcard[i] !== target[i]) return false;
	return wildcard[last] === "[^]*" || target.length === last || target[last] === "/";
}
var RegExpRouter = class {
	name = "RegExpRouter";
	#handlers;
	#tries;
	constructor() {
		this.#handlers = { ["ALL"]: [] };
		this.#tries = { ["ALL"]: new Trie() };
	}
	#insertPath(method, path) {
		try {
			this.#tries[method].insert(path, !/\*|\/:/.test(path));
		} catch (e) {
			throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
		}
	}
	add(method, path, handler) {
		const handlers = this.#handlers;
		if (!handlers) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
		const tries = this.#tries;
		if (!handlers[method]) {
			tries[method] = new Trie();
			handlers[method] = [...handlers["ALL"]];
			for (const p in tries["ALL"].paths) this.#insertPath(method, p);
		}
		if (path === "/*") path = "*";
		const methods = method === "ALL" ? Object.keys(handlers) : [method];
		const paths = checkOptionalParameter(path) || [path];
		for (const path of paths) for (const m of methods) {
			if (!tries[m].paths[path]) this.#insertPath(m, path);
			handlers[m].push([handler, path]);
		}
	}
	match = match;
	buildAllMatchers() {
		const matchers = createNullObject();
		for (const method of Object.keys(this.#handlers)) matchers[method] = this.#buildMatcher(method);
		this.#handlers = this.#tries = void 0;
		return matchers;
	}
	#buildMatcher(method) {
		const handlers = this.#handlers[method];
		const trie = this.#tries[method];
		const staticMap = createNullObject();
		const handlerData = [];
		const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
		const own = createNullObject();
		const entries = handlers.map(([h, p], i) => {
			(own[p] ??= []).push(i);
			return [h, trie.paths[p][1].reduceRight((map, [key, varIndex]) => {
				map[key] = paramReplacementMap[varIndex];
				return map;
			}, createNullObject())];
		});
		const wildcards = Object.keys(own).filter((p) => endsWithWildcard(trie.paths[p][2]));
		for (const path in trie.paths) {
			const [index, , keys] = trie.paths[path];
			const indexes = [...own[path]];
			for (const p of wildcards) if (p !== path && covers(trie.paths[p][2], keys)) indexes.push(...own[p]);
			const data = indexes.sort((a, b) => a - b).map((i) => entries[i]);
			if (index === -1) {
				const last = Math.max(-1, ...data.flatMap(([, map]) => Object.values(map)));
				staticMap[path] = [data, last === -1 ? emptyParam : path.match(regexp).slice(0, last + 1)];
			} else handlerData[index] = data;
		}
		return [
			regexp,
			indexReplacementMap.map((i) => handlerData[i]),
			staticMap
		];
	}
};
// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
	name = "SmartRouter";
	#routers = [];
	#routes = [];
	constructor(init) {
		this.#routers = init.routers;
	}
	add(method, path, handler) {
		if (!this.#routes) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
		this.#routes.push([
			method,
			path,
			handler
		]);
	}
	match(method, path) {
		if (!this.#routes) throw new Error("Fatal error");
		const routers = this.#routers;
		const routes = this.#routes;
		const len = routers.length;
		let i = 0;
		let res;
		for (; i < len; i++) {
			const router = routers[i];
			try {
				for (let i = 0, len = routes.length; i < len; i++) router.add(...routes[i]);
				res = router.match(method, path);
			} catch (e) {
				if (e instanceof UnsupportedPathError) continue;
				throw e;
			}
			this.match = router.match.bind(router);
			this.#routers = [router];
			this.#routes = void 0;
			break;
		}
		if (i === len) throw new Error("Fatal error");
		this.name = `SmartRouter + ${this.activeRouter.name}`;
		return res;
	}
	get activeRouter() {
		if (this.#routes || this.#routers.length !== 1) throw new Error("No active router has been determined yet.");
		return this.#routers[0];
	}
};
// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = createNullObject();
var order = 0;
var Node = class Node {
	#methods = [];
	#children = createNullObject();
	#patterns = [];
	#pattern;
	#params = emptyParams;
	insert(method, path, handler) {
		let curNode = this;
		const parts = splitRoutingPath(path);
		const possibleKeys = /* @__PURE__ */ new Set();
		let i = 0;
		for (const p of parts) {
			const nextP = parts[++i];
			const pattern = getPattern(p, nextP) || (nextP === void 0 && p && p.indexOf("*") === p.length - 1 ? p : null);
			const isParam = Array.isArray(pattern);
			const key = isParam ? pattern[0] : pattern || p;
			const child = curNode.#children[key] ||= new Node();
			if (pattern && !child.#pattern) {
				child.#pattern = pattern;
				curNode.#patterns.push(child);
			}
			curNode = child;
			if (isParam) possibleKeys.add(pattern[1]);
		}
		curNode.#methods.push({ [method]: {
			handler,
			possibleKeys: [...possibleKeys],
			score: ++order
		} });
	}
	#pushHandlerSets(handlerSets, node, method, nodeParams, params) {
		for (let i = 0, len = node.#methods.length; i < len; i++) {
			const m = node.#methods[i];
			const handlerSet = m[method] || m["ALL"];
			if (handlerSet) {
				handlerSet.params = createNullObject();
				handlerSets.push(handlerSet);
				for (let i = 0, len = handlerSet.possibleKeys.length; i < len; i++) {
					const key = handlerSet.possibleKeys[i];
					handlerSet.params[key] = params?.[key] && !i ? params[key] : nodeParams[key] ?? params?.[key];
				}
			}
		}
	}
	search(method, path) {
		const handlerSets = [];
		this.#params = emptyParams;
		let curNodes = [this];
		const parts = splitPath(path);
		const curNodesQueue = [];
		const len = parts.length;
		let partOffsets = null;
		for (let i = 0; i < len; i++) {
			const part = parts[i];
			const isLast = i === len - 1;
			const tempNodes = [];
			for (let j = 0, len2 = curNodes.length; j < len2; j++) {
				const node = curNodes[j];
				const nextNode = node.#children[part];
				if (nextNode) {
					nextNode.#params = node.#params;
					if (isLast) {
						if (nextNode.#children["*"]) this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
						this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
					} else tempNodes.push(nextNode);
				}
				for (const child of node.#patterns) {
					const pattern = child.#pattern;
					const params = node.#params === emptyParams ? {} : { ...node.#params };
					if (typeof pattern === "string") {
						if (pattern === "*" || part.startsWith(pattern.slice(0, -1))) {
							this.#pushHandlerSets(handlerSets, child, method, node.#params);
							if (pattern === "*") {
								child.#params = params;
								tempNodes.push(child);
							}
						}
						continue;
					}
					const [, name, matcher] = pattern;
					if (!part && matcher === true) continue;
					if (matcher !== true) {
						if (!partOffsets) {
							partOffsets = [];
							let offset = path[0] === "/" ? 1 : 0;
							for (let p = 0; p < len; p++) {
								partOffsets[p] = offset;
								offset += parts[p].length + 1;
							}
						}
						const restPathString = path.slice(partOffsets[i]);
						const m = matcher.exec(restPathString);
						if (m) {
							if (!Object.hasOwn(params, name)) params[name] = m[0];
							this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
							if (m[0].length === restPathString.length && child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, node.#params, params);
							for (const _ in child.#children) {
								child.#params = params;
								const componentCount = m[0].match(/\//g)?.length ?? 0;
								(curNodesQueue[componentCount] ||= []).push(child);
								break;
							}
							continue;
						}
					}
					if (matcher === true || matcher.test(part)) {
						if (!Object.hasOwn(params, name)) params[name] = part;
						if (isLast) {
							this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
							if (child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, params, node.#params);
						} else {
							child.#params = params;
							tempNodes.push(child);
						}
					}
				}
			}
			const shifted = curNodesQueue.shift();
			curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
		}
		if (handlerSets[1]) handlerSets.sort((a, b) => {
			return a.score - b.score;
		});
		return [handlerSets.map(({ handler, params }) => [handler, params])];
	}
};
// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
	name = "TrieRouter";
	#node = new Node();
	add(method, path, handler) {
		for (const result of checkOptionalParameter(path) || [path]) this.#node.insert(method, result, handler);
	}
	match(method, path) {
		return this.#node.search(method, path);
	}
};
// node_modules/hono/dist/hono.js
/**
* The Hono class extends the functionality of the HonoBase class.
* It sets up routing and allows for custom options to be passed.
*
* @template E - The environment type.
* @template S - The schema type.
* @template BasePath - The base path type.
*/
var Hono = class extends Hono$1 {
	/**
	* Creates an instance of the Hono class.
	*
	* @param options - Optional configuration options for the Hono instance.
	*/
	constructor(options = {}) {
		super(options);
		this.router = options.router ?? new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] });
	}
};
// node_modules/hono/dist/middleware/body-limit/index.js
var ERROR_MESSAGE = "Payload Too Large";
/**
* Body Limit Middleware for Hono.
*
* @see {@link https://hono.dev/docs/middleware/builtin/body-limit}
*
* @param {BodyLimitOptions} options - The options for the body limit middleware.
* @param {number} options.maxSize - The maximum body size allowed.
* @param {OnError} [options.onError] - The error handler to be invoked if the specified body size is exceeded.
* @returns {MiddlewareHandler} The middleware handler function.
*
* @example
* ```ts
* const app = new Hono()
*
* app.post(
*   '/upload',
*   bodyLimit({
*     maxSize: 50 * 1024, // 50kb
*     onError: (c) => {
*       return c.text('overflow :(', 413)
*     },
*   }),
*   async (c) => {
*     const body = await c.req.parseBody()
*     if (body['file'] instanceof File) {
*       console.log(`Got file sized: ${body['file'].size}`)
*     }
*     return c.text('pass :)')
*   }
* )
* ```
*/
var bodyLimit = (options) => {
	const onError = options.onError || (() => {
		throw new HTTPException(413, { res: new Response(ERROR_MESSAGE, { status: 413 }) });
	});
	const maxSize = options.maxSize;
	return async function bodyLimit(c, next) {
		if (!c.req.raw.body) return next();
		const hasTransferEncoding = c.req.raw.headers.has("transfer-encoding");
		if (c.req.raw.headers.has("content-length") && !hasTransferEncoding) return parseInt(c.req.raw.headers.get("content-length") || "0", 10) > maxSize ? onError(c) : next();
		let size = 0;
		let buffer = /* @__PURE__ */ new Uint8Array(0);
		const rawReader = c.req.raw.body.getReader();
		for (;;) {
			const { done, value } = await rawReader.read();
			if (done) break;
			const offset = size;
			size += value.length;
			if (size > maxSize) return onError(c);
			if (size > buffer.length) {
				const grown = new Uint8Array(Math.min(maxSize, Math.max(size, buffer.length * 2)));
				grown.set(buffer.subarray(0, offset));
				buffer = grown;
			}
			buffer.set(value, offset);
		}
		c.req.raw = new Request(c.req.raw, { body: buffer.subarray(0, size) });
		return next();
	};
};
// node_modules/hono/dist/middleware/secure-headers/secure-headers.js
var HEADERS_MAP = {
	crossOriginEmbedderPolicy: ["Cross-Origin-Embedder-Policy", "require-corp"],
	crossOriginResourcePolicy: ["Cross-Origin-Resource-Policy", "same-origin"],
	crossOriginOpenerPolicy: ["Cross-Origin-Opener-Policy", "same-origin"],
	originAgentCluster: ["Origin-Agent-Cluster", "?1"],
	referrerPolicy: ["Referrer-Policy", "no-referrer"],
	strictTransportSecurity: ["Strict-Transport-Security", "max-age=15552000; includeSubDomains"],
	xContentTypeOptions: ["X-Content-Type-Options", "nosniff"],
	xDnsPrefetchControl: ["X-DNS-Prefetch-Control", "off"],
	xDownloadOptions: ["X-Download-Options", "noopen"],
	xFrameOptions: ["X-Frame-Options", "SAMEORIGIN"],
	xPermittedCrossDomainPolicies: ["X-Permitted-Cross-Domain-Policies", "none"],
	xXssProtection: ["X-XSS-Protection", "0"]
};
var DEFAULT_OPTIONS = {
	crossOriginEmbedderPolicy: false,
	crossOriginResourcePolicy: true,
	crossOriginOpenerPolicy: true,
	originAgentCluster: true,
	referrerPolicy: true,
	strictTransportSecurity: true,
	xContentTypeOptions: true,
	xDnsPrefetchControl: true,
	xDownloadOptions: true,
	xFrameOptions: true,
	xPermittedCrossDomainPolicies: true,
	xXssProtection: true,
	removePoweredBy: true,
	permissionsPolicy: {},
	overwrite: true
};
/**
* Secure Headers Middleware for Hono.
*
* @see {@link https://hono.dev/docs/middleware/builtin/secure-headers}
*
* @param {Partial<SecureHeadersOptions>} [customOptions] - The options for the secure headers middleware.
* @param {ContentSecurityPolicyOptions} [customOptions.contentSecurityPolicy] - Settings for the Content-Security-Policy header.
* @param {ContentSecurityPolicyOptions} [customOptions.contentSecurityPolicyReportOnly] - Settings for the Content-Security-Policy-Report-Only header.
* @param {overridableHeader} [customOptions.crossOriginEmbedderPolicy=false] - Settings for the Cross-Origin-Embedder-Policy header.
* @param {overridableHeader} [customOptions.crossOriginResourcePolicy=true] - Settings for the Cross-Origin-Resource-Policy header.
* @param {overridableHeader} [customOptions.crossOriginOpenerPolicy=true] - Settings for the Cross-Origin-Opener-Policy header.
* @param {overridableHeader} [customOptions.originAgentCluster=true] - Settings for the Origin-Agent-Cluster header.
* @param {overridableHeader} [customOptions.referrerPolicy=true] - Settings for the Referrer-Policy header.
* @param {ReportingEndpointOptions[]} [customOptions.reportingEndpoints] - Settings for the Reporting-Endpoints header.
* @param {ReportToOptions[]} [customOptions.reportTo] - Settings for the Report-To header.
* @param {overridableHeader} [customOptions.strictTransportSecurity=true] - Settings for the Strict-Transport-Security header.
* @param {overridableHeader} [customOptions.xContentTypeOptions=true] - Settings for the X-Content-Type-Options header.
* @param {overridableHeader} [customOptions.xDnsPrefetchControl=true] - Settings for the X-DNS-Prefetch-Control header.
* @param {overridableHeader} [customOptions.xDownloadOptions=true] - Settings for the X-Download-Options header.
* @param {overridableHeader} [customOptions.xFrameOptions=true] - Settings for the X-Frame-Options header.
* @param {overridableHeader} [customOptions.xPermittedCrossDomainPolicies=true] - Settings for the X-Permitted-Cross-Domain-Policies header.
* @param {overridableHeader} [customOptions.xXssProtection=true] - Settings for the X-XSS-Protection header.
* @param {boolean} [customOptions.removePoweredBy=true] - Settings for remove X-Powered-By header.
* @param {PermissionsPolicyOptions} [customOptions.permissionsPolicy] - Settings for the Permissions-Policy header.
* @param {boolean} [customOptions.overwrite=true] - Whether to replace a header that the response already has. Set `false` to keep a header that a handler set itself.
* @returns {MiddlewareHandler} The middleware handler function.
*
* @example
* ```ts
* const app = new Hono()
* app.use(secureHeaders())
* ```
*/
var secureHeaders = (customOptions) => {
	const options = {
		...DEFAULT_OPTIONS,
		...customOptions
	};
	const headersToSet = getFilteredHeaders(options);
	const callbacks = [];
	if (options.contentSecurityPolicy) {
		const [callback, value] = getCSPDirectives(options.contentSecurityPolicy, "Content-Security-Policy");
		if (callback) callbacks.push(callback);
		headersToSet.push(["Content-Security-Policy", value]);
	}
	if (options.contentSecurityPolicyReportOnly) {
		const [callback, value] = getCSPDirectives(options.contentSecurityPolicyReportOnly, "Content-Security-Policy-Report-Only");
		if (callback) callbacks.push(callback);
		headersToSet.push(["Content-Security-Policy-Report-Only", value]);
	}
	if (options.permissionsPolicy && Object.keys(options.permissionsPolicy).length > 0) headersToSet.push(["Permissions-Policy", getPermissionsPolicyDirectives(options.permissionsPolicy)]);
	if (options.reportingEndpoints) headersToSet.push(["Reporting-Endpoints", getReportingEndpoints(options.reportingEndpoints)]);
	if (options.reportTo) headersToSet.push(["Report-To", getReportToOptions(options.reportTo)]);
	return async function secureHeaders(ctx, next) {
		const headersToSetForReq = callbacks.length === 0 ? headersToSet : callbacks.reduce((acc, cb) => cb(ctx, acc), headersToSet);
		await next();
		setHeaders(ctx, headersToSetForReq, options.overwrite !== false);
		if (options?.removePoweredBy) ctx.res.headers.delete("X-Powered-By");
	};
};
function getFilteredHeaders(options) {
	return Object.entries(HEADERS_MAP).filter(([key]) => options[key]).map(([key, defaultValue]) => {
		const overrideValue = options[key];
		return typeof overrideValue === "string" ? [defaultValue[0], overrideValue] : defaultValue;
	});
}
function getCSPDirectives(contentSecurityPolicy, headerName) {
	const callbacks = [];
	const resultValues = [];
	for (const [directive, value] of Object.entries(contentSecurityPolicy)) {
		const valueArray = Array.isArray(value) ? value : [value];
		valueArray.forEach((value, i) => {
			if (typeof value === "function") {
				const index = i * 2 + 2 + resultValues.length;
				callbacks.push((ctx, values) => {
					values[index] = value(ctx, directive);
				});
			}
		});
		resultValues.push(directive.replace(/[A-Z]+(?![a-z])|[A-Z]/g, (match, offset) => offset ? "-" + match.toLowerCase() : match.toLowerCase()), ...valueArray.flatMap((value) => [" ", value]), "; ");
	}
	resultValues.pop();
	return callbacks.length === 0 ? [void 0, resultValues.join("")] : [(ctx, headersToSet) => headersToSet.map((values) => {
		if (values[0] === headerName) {
			const clone = values[1].slice();
			callbacks.forEach((cb) => {
				cb(ctx, clone);
			});
			return [values[0], clone.join("")];
		} else return values;
	}), resultValues];
}
function getPermissionsPolicyDirectives(policy) {
	return Object.entries(policy).map(([directive, value]) => {
		const kebabDirective = camelToKebab(directive);
		if (typeof value === "boolean") return `${kebabDirective}=${value ? "*" : "()"}`;
		if (Array.isArray(value)) {
			if (value.length === 0) return `${kebabDirective}=()`;
			if (value.length === 1 && value[0] === "*") return `${kebabDirective}=*`;
			if (value.length === 1 && value[0] === "none") return `${kebabDirective}=()`;
			return `${kebabDirective}=(${value.map((item) => ["self", "src"].includes(item) ? item : `"${item}"`).join(" ")})`;
		}
		return "";
	}).filter(Boolean).join(", ");
}
function camelToKebab(str) {
	return str.replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase();
}
function getReportingEndpoints(reportingEndpoints = []) {
	return reportingEndpoints.map((endpoint) => `${endpoint.name}="${endpoint.url}"`).join(", ");
}
function getReportToOptions(reportTo = []) {
	return reportTo.map((option) => JSON.stringify(option)).join(", ");
}
function setHeaders(ctx, headersToSet, overwrite) {
	headersToSet.forEach(([header, value]) => {
		if (!overwrite && ctx.res.headers.has(header)) return;
		ctx.res.headers.set(header, value);
	});
}
// node_modules/zod/v3/helpers/util.js
var util;
(function(util) {
	util.assertEqual = (_) => {};
	function assertIs(_arg) {}
	util.assertIs = assertIs;
	function assertNever(_x) {
		throw new Error();
	}
	util.assertNever = assertNever;
	util.arrayToEnum = (items) => {
		const obj = {};
		for (const item of items) obj[item] = item;
		return obj;
	};
	util.getValidEnumValues = (obj) => {
		const validKeys = util.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
		const filtered = {};
		for (const k of validKeys) filtered[k] = obj[k];
		return util.objectValues(filtered);
	};
	util.objectValues = (obj) => {
		return util.objectKeys(obj).map(function(e) {
			return obj[e];
		});
	};
	util.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
		const keys = [];
		for (const key in object) if (Object.prototype.hasOwnProperty.call(object, key)) keys.push(key);
		return keys;
	};
	util.find = (arr, checker) => {
		for (const item of arr) if (checker(item)) return item;
	};
	util.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
	function joinValues(array, separator = " | ") {
		return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
	}
	util.joinValues = joinValues;
	util.jsonStringifyReplacer = (_, value) => {
		if (typeof value === "bigint") return value.toString();
		return value;
	};
})(util || (util = {}));
var objectUtil;
(function(objectUtil) {
	objectUtil.mergeShapes = (first, second) => {
		return {
			...first,
			...second
		};
	};
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
	"string",
	"nan",
	"number",
	"integer",
	"float",
	"boolean",
	"date",
	"bigint",
	"symbol",
	"function",
	"undefined",
	"null",
	"array",
	"object",
	"unknown",
	"promise",
	"void",
	"never",
	"map",
	"set"
]);
var getParsedType = (data) => {
	switch (typeof data) {
		case "undefined": return ZodParsedType.undefined;
		case "string": return ZodParsedType.string;
		case "number": return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
		case "boolean": return ZodParsedType.boolean;
		case "function": return ZodParsedType.function;
		case "bigint": return ZodParsedType.bigint;
		case "symbol": return ZodParsedType.symbol;
		case "object":
			if (Array.isArray(data)) return ZodParsedType.array;
			if (data === null) return ZodParsedType.null;
			if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") return ZodParsedType.promise;
			if (typeof Map !== "undefined" && data instanceof Map) return ZodParsedType.map;
			if (typeof Set !== "undefined" && data instanceof Set) return ZodParsedType.set;
			if (typeof Date !== "undefined" && data instanceof Date) return ZodParsedType.date;
			return ZodParsedType.object;
		default: return ZodParsedType.unknown;
	}
};
// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
	"invalid_type",
	"invalid_literal",
	"custom",
	"invalid_union",
	"invalid_union_discriminator",
	"invalid_enum_value",
	"unrecognized_keys",
	"invalid_arguments",
	"invalid_return_type",
	"invalid_date",
	"invalid_string",
	"too_small",
	"too_big",
	"invalid_intersection_types",
	"not_multiple_of",
	"not_finite"
]);
var ZodError = class ZodError extends Error {
	get errors() {
		return this.issues;
	}
	constructor(issues) {
		super();
		this.issues = [];
		this.addIssue = (sub) => {
			this.issues = [...this.issues, sub];
		};
		this.addIssues = (subs = []) => {
			this.issues = [...this.issues, ...subs];
		};
		const actualProto = new.target.prototype;
		if (Object.setPrototypeOf) Object.setPrototypeOf(this, actualProto);
		else this.__proto__ = actualProto;
		this.name = "ZodError";
		this.issues = issues;
	}
	format(_mapper) {
		const mapper = _mapper || function(issue) {
			return issue.message;
		};
		const fieldErrors = { _errors: [] };
		const processError = (error) => {
			for (const issue of error.issues) if (issue.code === "invalid_union") issue.unionErrors.map(processError);
			else if (issue.code === "invalid_return_type") processError(issue.returnTypeError);
			else if (issue.code === "invalid_arguments") processError(issue.argumentsError);
			else if (issue.path.length === 0) fieldErrors._errors.push(mapper(issue));
			else {
				let curr = fieldErrors;
				let i = 0;
				while (i < issue.path.length) {
					const el = issue.path[i];
					if (!(i === issue.path.length - 1)) curr[el] = curr[el] || { _errors: [] };
					else {
						curr[el] = curr[el] || { _errors: [] };
						curr[el]._errors.push(mapper(issue));
					}
					curr = curr[el];
					i++;
				}
			}
		};
		processError(this);
		return fieldErrors;
	}
	static assert(value) {
		if (!(value instanceof ZodError)) throw new Error(`Not a ZodError: ${value}`);
	}
	toString() {
		return this.message;
	}
	get message() {
		return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
	}
	get isEmpty() {
		return this.issues.length === 0;
	}
	flatten(mapper = (issue) => issue.message) {
		const fieldErrors = {};
		const formErrors = [];
		for (const sub of this.issues) if (sub.path.length > 0) {
			const firstEl = sub.path[0];
			fieldErrors[firstEl] = fieldErrors[firstEl] || [];
			fieldErrors[firstEl].push(mapper(sub));
		} else formErrors.push(mapper(sub));
		return {
			formErrors,
			fieldErrors
		};
	}
	get formErrors() {
		return this.flatten();
	}
};
ZodError.create = (issues) => {
	return new ZodError(issues);
};
// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
	let message;
	switch (issue.code) {
		case ZodIssueCode.invalid_type:
			if (issue.received === ZodParsedType.undefined) message = "Required";
			else message = `Expected ${issue.expected}, received ${issue.received}`;
			break;
		case ZodIssueCode.invalid_literal:
			message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
			break;
		case ZodIssueCode.unrecognized_keys:
			message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
			break;
		case ZodIssueCode.invalid_union:
			message = `Invalid input`;
			break;
		case ZodIssueCode.invalid_union_discriminator:
			message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
			break;
		case ZodIssueCode.invalid_enum_value:
			message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
			break;
		case ZodIssueCode.invalid_arguments:
			message = `Invalid function arguments`;
			break;
		case ZodIssueCode.invalid_return_type:
			message = `Invalid function return type`;
			break;
		case ZodIssueCode.invalid_date:
			message = `Invalid date`;
			break;
		case ZodIssueCode.invalid_string:
			if (typeof issue.validation === "object") {
				if ("includes" in issue.validation) {
					message = `Invalid input: must include "${issue.validation.includes}"`;
					if (typeof issue.validation.position === "number") message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
				} else if ("startsWith" in issue.validation) message = `Invalid input: must start with "${issue.validation.startsWith}"`;
				else if ("endsWith" in issue.validation) message = `Invalid input: must end with "${issue.validation.endsWith}"`;
				else util.assertNever(issue.validation);
			} else if (issue.validation !== "regex") message = `Invalid ${issue.validation}`;
			else message = "Invalid";
			break;
		case ZodIssueCode.too_small:
			if (issue.type === "array") message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
			else if (issue.type === "string") message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
			else if (issue.type === "number") message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
			else if (issue.type === "bigint") message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
			else if (issue.type === "date") message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
			else message = "Invalid input";
			break;
		case ZodIssueCode.too_big:
			if (issue.type === "array") message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
			else if (issue.type === "string") message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
			else if (issue.type === "number") message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
			else if (issue.type === "bigint") message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
			else if (issue.type === "date") message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
			else message = "Invalid input";
			break;
		case ZodIssueCode.custom:
			message = `Invalid input`;
			break;
		case ZodIssueCode.invalid_intersection_types:
			message = `Intersection results could not be merged`;
			break;
		case ZodIssueCode.not_multiple_of:
			message = `Number must be a multiple of ${issue.multipleOf}`;
			break;
		case ZodIssueCode.not_finite:
			message = "Number must be finite";
			break;
		default:
			message = _ctx.defaultError;
			util.assertNever(issue);
	}
	return { message };
};
// node_modules/zod/v3/errors.js
var overrideErrorMap = errorMap;
function getErrorMap() {
	return overrideErrorMap;
}
// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
	const { data, path, errorMaps, issueData } = params;
	const fullPath = [...path, ...issueData.path || []];
	const fullIssue = {
		...issueData,
		path: fullPath
	};
	if (issueData.message !== void 0) return {
		...issueData,
		path: fullPath,
		message: issueData.message
	};
	let errorMessage = "";
	const maps = errorMaps.filter((m) => !!m).slice().reverse();
	for (const map of maps) errorMessage = map(fullIssue, {
		data,
		defaultError: errorMessage
	}).message;
	return {
		...issueData,
		path: fullPath,
		message: errorMessage
	};
};
function addIssueToContext(ctx, issueData) {
	const overrideMap = getErrorMap();
	const issue = makeIssue({
		issueData,
		data: ctx.data,
		path: ctx.path,
		errorMaps: [
			ctx.common.contextualErrorMap,
			ctx.schemaErrorMap,
			overrideMap,
			overrideMap === errorMap ? void 0 : errorMap
		].filter((x) => !!x)
	});
	ctx.common.issues.push(issue);
}
var ParseStatus = class ParseStatus {
	constructor() {
		this.value = "valid";
	}
	dirty() {
		if (this.value === "valid") this.value = "dirty";
	}
	abort() {
		if (this.value !== "aborted") this.value = "aborted";
	}
	static mergeArray(status, results) {
		const arrayValue = [];
		for (const s of results) {
			if (s.status === "aborted") return INVALID;
			if (s.status === "dirty") status.dirty();
			arrayValue.push(s.value);
		}
		return {
			status: status.value,
			value: arrayValue
		};
	}
	static async mergeObjectAsync(status, pairs) {
		const syncPairs = [];
		for (const pair of pairs) {
			const key = await pair.key;
			const value = await pair.value;
			syncPairs.push({
				key,
				value
			});
		}
		return ParseStatus.mergeObjectSync(status, syncPairs);
	}
	static mergeObjectSync(status, pairs) {
		const finalObject = {};
		for (const pair of pairs) {
			const { key, value } = pair;
			if (key.status === "aborted") return INVALID;
			if (value.status === "aborted") return INVALID;
			if (key.status === "dirty") status.dirty();
			if (value.status === "dirty") status.dirty();
			if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) finalObject[key.value] = value.value;
		}
		return {
			status: status.value,
			value: finalObject
		};
	}
};
var INVALID = Object.freeze({ status: "aborted" });
var DIRTY = (value) => ({
	status: "dirty",
	value
});
var OK = (value) => ({
	status: "valid",
	value
});
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil) {
	errorUtil.errToObj = (message) => typeof message === "string" ? { message } : message || {};
	errorUtil.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));
// node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
	constructor(parent, value, path, key) {
		this._cachedPath = [];
		this.parent = parent;
		this.data = value;
		this._path = path;
		this._key = key;
	}
	get path() {
		if (!this._cachedPath.length) {
			if (Array.isArray(this._key)) this._cachedPath.push(...this._path, ...this._key);
			else this._cachedPath.push(...this._path, this._key);
		}
		return this._cachedPath;
	}
};
var handleResult = (ctx, result) => {
	if (isValid(result)) return {
		success: true,
		data: result.value
	};
	else {
		if (!ctx.common.issues.length) throw new Error("Validation failed but no issues detected.");
		return {
			success: false,
			get error() {
				if (this._error) return this._error;
				const error = new ZodError(ctx.common.issues);
				this._error = error;
				return this._error;
			}
		};
	}
};
function processCreateParams(params) {
	if (!params) return {};
	const { errorMap, invalid_type_error, required_error, description } = params;
	if (errorMap && (invalid_type_error || required_error)) throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
	if (errorMap) return {
		errorMap,
		description
	};
	const customMap = (iss, ctx) => {
		const { message } = params;
		if (iss.code === "invalid_enum_value") return { message: message ?? ctx.defaultError };
		if (typeof ctx.data === "undefined") return { message: message ?? required_error ?? ctx.defaultError };
		if (iss.code !== "invalid_type") return { message: ctx.defaultError };
		return { message: message ?? invalid_type_error ?? ctx.defaultError };
	};
	return {
		errorMap: customMap,
		description
	};
}
var ZodType = class {
	get description() {
		return this._def.description;
	}
	_getType(input) {
		return getParsedType(input.data);
	}
	_getOrReturnCtx(input, ctx) {
		return ctx || {
			common: input.parent.common,
			data: input.data,
			parsedType: getParsedType(input.data),
			schemaErrorMap: this._def.errorMap,
			path: input.path,
			parent: input.parent
		};
	}
	_processInputParams(input) {
		return {
			status: new ParseStatus(),
			ctx: {
				common: input.parent.common,
				data: input.data,
				parsedType: getParsedType(input.data),
				schemaErrorMap: this._def.errorMap,
				path: input.path,
				parent: input.parent
			}
		};
	}
	_parseSync(input) {
		const result = this._parse(input);
		if (isAsync(result)) throw new Error("Synchronous parse encountered promise.");
		return result;
	}
	_parseAsync(input) {
		const result = this._parse(input);
		return Promise.resolve(result);
	}
	parse(data, params) {
		const result = this.safeParse(data, params);
		if (result.success) return result.data;
		throw result.error;
	}
	safeParse(data, params) {
		const ctx = {
			common: {
				issues: [],
				async: params?.async ?? false,
				contextualErrorMap: params?.errorMap
			},
			path: params?.path || [],
			schemaErrorMap: this._def.errorMap,
			parent: null,
			data,
			parsedType: getParsedType(data)
		};
		return handleResult(ctx, this._parseSync({
			data,
			path: ctx.path,
			parent: ctx
		}));
	}
	"~validate"(data) {
		const ctx = {
			common: {
				issues: [],
				async: !!this["~standard"].async
			},
			path: [],
			schemaErrorMap: this._def.errorMap,
			parent: null,
			data,
			parsedType: getParsedType(data)
		};
		if (!this["~standard"].async) try {
			const result = this._parseSync({
				data,
				path: [],
				parent: ctx
			});
			return isValid(result) ? { value: result.value } : { issues: ctx.common.issues };
		} catch (err) {
			if (err?.message?.toLowerCase()?.includes("encountered")) this["~standard"].async = true;
			ctx.common = {
				issues: [],
				async: true
			};
		}
		return this._parseAsync({
			data,
			path: [],
			parent: ctx
		}).then((result) => isValid(result) ? { value: result.value } : { issues: ctx.common.issues });
	}
	async parseAsync(data, params) {
		const result = await this.safeParseAsync(data, params);
		if (result.success) return result.data;
		throw result.error;
	}
	async safeParseAsync(data, params) {
		const ctx = {
			common: {
				issues: [],
				contextualErrorMap: params?.errorMap,
				async: true
			},
			path: params?.path || [],
			schemaErrorMap: this._def.errorMap,
			parent: null,
			data,
			parsedType: getParsedType(data)
		};
		const maybeAsyncResult = this._parse({
			data,
			path: ctx.path,
			parent: ctx
		});
		return handleResult(ctx, await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult)));
	}
	refine(check, message) {
		const getIssueProperties = (val) => {
			if (typeof message === "string" || typeof message === "undefined") return { message };
			else if (typeof message === "function") return message(val);
			else return message;
		};
		return this._refinement((val, ctx) => {
			const result = check(val);
			const setError = () => ctx.addIssue({
				code: ZodIssueCode.custom,
				...getIssueProperties(val)
			});
			if (typeof Promise !== "undefined" && result instanceof Promise) return result.then((data) => {
				if (!data) {
					setError();
					return false;
				} else return true;
			});
			if (!result) {
				setError();
				return false;
			} else return true;
		});
	}
	refinement(check, refinementData) {
		return this._refinement((val, ctx) => {
			if (!check(val)) {
				ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
				return false;
			} else return true;
		});
	}
	_refinement(refinement) {
		return new ZodEffects({
			schema: this,
			typeName: ZodFirstPartyTypeKind.ZodEffects,
			effect: {
				type: "refinement",
				refinement
			}
		});
	}
	superRefine(refinement) {
		return this._refinement(refinement);
	}
	constructor(def) {
		/** Alias of safeParseAsync */
		this.spa = this.safeParseAsync;
		this._def = def;
		this.parse = this.parse.bind(this);
		this.safeParse = this.safeParse.bind(this);
		this.parseAsync = this.parseAsync.bind(this);
		this.safeParseAsync = this.safeParseAsync.bind(this);
		this.spa = this.spa.bind(this);
		this.refine = this.refine.bind(this);
		this.refinement = this.refinement.bind(this);
		this.superRefine = this.superRefine.bind(this);
		this.optional = this.optional.bind(this);
		this.nullable = this.nullable.bind(this);
		this.nullish = this.nullish.bind(this);
		this.array = this.array.bind(this);
		this.promise = this.promise.bind(this);
		this.or = this.or.bind(this);
		this.and = this.and.bind(this);
		this.transform = this.transform.bind(this);
		this.brand = this.brand.bind(this);
		this.default = this.default.bind(this);
		this.catch = this.catch.bind(this);
		this.describe = this.describe.bind(this);
		this.pipe = this.pipe.bind(this);
		this.readonly = this.readonly.bind(this);
		this.isNullable = this.isNullable.bind(this);
		this.isOptional = this.isOptional.bind(this);
		this["~standard"] = {
			version: 1,
			vendor: "zod",
			validate: (data) => this["~validate"](data)
		};
	}
	optional() {
		return ZodOptional.create(this, this._def);
	}
	nullable() {
		return ZodNullable.create(this, this._def);
	}
	nullish() {
		return this.nullable().optional();
	}
	array() {
		return ZodArray.create(this);
	}
	promise() {
		return ZodPromise.create(this, this._def);
	}
	or(option) {
		return ZodUnion.create([this, option], this._def);
	}
	and(incoming) {
		return ZodIntersection.create(this, incoming, this._def);
	}
	transform(transform) {
		return new ZodEffects({
			...processCreateParams(this._def),
			schema: this,
			typeName: ZodFirstPartyTypeKind.ZodEffects,
			effect: {
				type: "transform",
				transform
			}
		});
	}
	default(def) {
		const defaultValueFunc = typeof def === "function" ? def : () => def;
		return new ZodDefault({
			...processCreateParams(this._def),
			innerType: this,
			defaultValue: defaultValueFunc,
			typeName: ZodFirstPartyTypeKind.ZodDefault
		});
	}
	brand() {
		return new ZodBranded({
			typeName: ZodFirstPartyTypeKind.ZodBranded,
			type: this,
			...processCreateParams(this._def)
		});
	}
	catch(def) {
		const catchValueFunc = typeof def === "function" ? def : () => def;
		return new ZodCatch({
			...processCreateParams(this._def),
			innerType: this,
			catchValue: catchValueFunc,
			typeName: ZodFirstPartyTypeKind.ZodCatch
		});
	}
	describe(description) {
		const This = this.constructor;
		return new This({
			...this._def,
			description
		});
	}
	pipe(target) {
		return ZodPipeline.create(this, target);
	}
	readonly() {
		return ZodReadonly.create(this);
	}
	isOptional() {
		return this.safeParse(void 0).success;
	}
	isNullable() {
		return this.safeParse(null).success;
	}
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
	let secondsRegexSource = `[0-5]\\d`;
	if (args.precision) secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
	else if (args.precision == null) secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
	const secondsQuantifier = args.precision ? "+" : "?";
	return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
	return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
	let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
	const opts = [];
	opts.push(args.local ? `Z?` : `Z`);
	if (args.offset) opts.push(`([+-]\\d{2}:?\\d{2})`);
	regex = `${regex}(${opts.join("|")})`;
	return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
	if ((version === "v4" || !version) && ipv4Regex.test(ip)) return true;
	if ((version === "v6" || !version) && ipv6Regex.test(ip)) return true;
	return false;
}
function isValidJWT(jwt, alg) {
	if (!jwtRegex.test(jwt)) return false;
	try {
		const [header] = jwt.split(".");
		if (!header) return false;
		const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
		const decoded = JSON.parse(atob(base64));
		if (typeof decoded !== "object" || decoded === null) return false;
		if ("typ" in decoded && decoded?.typ !== "JWT") return false;
		if (!decoded.alg) return false;
		if (alg && decoded.alg !== alg) return false;
		return true;
	} catch {
		return false;
	}
}
function isValidCidr(ip, version) {
	if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) return true;
	if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) return true;
	return false;
}
var ZodString = class ZodString extends ZodType {
	_parse(input) {
		if (this._def.coerce) input.data = String(input.data);
		if (this._getType(input) !== ZodParsedType.string) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.string,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const status = new ParseStatus();
		let ctx = void 0;
		for (const check of this._def.checks) if (check.kind === "min") {
			if (input.data.length < check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					minimum: check.value,
					type: "string",
					inclusive: true,
					exact: false,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "max") {
			if (input.data.length > check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					maximum: check.value,
					type: "string",
					inclusive: true,
					exact: false,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "length") {
			const tooBig = input.data.length > check.value;
			const tooSmall = input.data.length < check.value;
			if (tooBig || tooSmall) {
				ctx = this._getOrReturnCtx(input, ctx);
				if (tooBig) addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					maximum: check.value,
					type: "string",
					inclusive: true,
					exact: true,
					message: check.message
				});
				else if (tooSmall) addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					minimum: check.value,
					type: "string",
					inclusive: true,
					exact: true,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "email") {
			if (!emailRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "email",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "emoji") {
			if (!emojiRegex) emojiRegex = new RegExp(_emojiRegex, "u");
			if (!emojiRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "emoji",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "uuid") {
			if (!uuidRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "uuid",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "nanoid") {
			if (!nanoidRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "nanoid",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "cuid") {
			if (!cuidRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "cuid",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "cuid2") {
			if (!cuid2Regex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "cuid2",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "ulid") {
			if (!ulidRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "ulid",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "url") try {
			new URL(input.data);
		} catch {
			ctx = this._getOrReturnCtx(input, ctx);
			addIssueToContext(ctx, {
				validation: "url",
				code: ZodIssueCode.invalid_string,
				message: check.message
			});
			status.dirty();
		}
		else if (check.kind === "regex") {
			check.regex.lastIndex = 0;
			if (!check.regex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "regex",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "trim") input.data = input.data.trim();
		else if (check.kind === "includes") {
			if (!input.data.includes(check.value, check.position)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: {
						includes: check.value,
						position: check.position
					},
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "toLowerCase") input.data = input.data.toLowerCase();
		else if (check.kind === "toUpperCase") input.data = input.data.toUpperCase();
		else if (check.kind === "startsWith") {
			if (!input.data.startsWith(check.value)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: { startsWith: check.value },
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "endsWith") {
			if (!input.data.endsWith(check.value)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: { endsWith: check.value },
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "datetime") {
			if (!datetimeRegex(check).test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: "datetime",
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "date") {
			if (!dateRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: "date",
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "time") {
			if (!timeRegex(check).test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: "time",
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "duration") {
			if (!durationRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "duration",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "ip") {
			if (!isValidIP(input.data, check.version)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "ip",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "jwt") {
			if (!isValidJWT(input.data, check.alg)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "jwt",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "cidr") {
			if (!isValidCidr(input.data, check.version)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "cidr",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "base64") {
			if (!base64Regex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "base64",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "base64url") {
			if (!base64urlRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "base64url",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else util.assertNever(check);
		return {
			status: status.value,
			value: input.data
		};
	}
	_regex(regex, validation, message) {
		return this.refinement((data) => regex.test(data), {
			validation,
			code: ZodIssueCode.invalid_string,
			...errorUtil.errToObj(message)
		});
	}
	_addCheck(check) {
		return new ZodString({
			...this._def,
			checks: [...this._def.checks, check]
		});
	}
	email(message) {
		return this._addCheck({
			kind: "email",
			...errorUtil.errToObj(message)
		});
	}
	url(message) {
		return this._addCheck({
			kind: "url",
			...errorUtil.errToObj(message)
		});
	}
	emoji(message) {
		return this._addCheck({
			kind: "emoji",
			...errorUtil.errToObj(message)
		});
	}
	uuid(message) {
		return this._addCheck({
			kind: "uuid",
			...errorUtil.errToObj(message)
		});
	}
	nanoid(message) {
		return this._addCheck({
			kind: "nanoid",
			...errorUtil.errToObj(message)
		});
	}
	cuid(message) {
		return this._addCheck({
			kind: "cuid",
			...errorUtil.errToObj(message)
		});
	}
	cuid2(message) {
		return this._addCheck({
			kind: "cuid2",
			...errorUtil.errToObj(message)
		});
	}
	ulid(message) {
		return this._addCheck({
			kind: "ulid",
			...errorUtil.errToObj(message)
		});
	}
	base64(message) {
		return this._addCheck({
			kind: "base64",
			...errorUtil.errToObj(message)
		});
	}
	base64url(message) {
		return this._addCheck({
			kind: "base64url",
			...errorUtil.errToObj(message)
		});
	}
	jwt(options) {
		return this._addCheck({
			kind: "jwt",
			...errorUtil.errToObj(options)
		});
	}
	ip(options) {
		return this._addCheck({
			kind: "ip",
			...errorUtil.errToObj(options)
		});
	}
	cidr(options) {
		return this._addCheck({
			kind: "cidr",
			...errorUtil.errToObj(options)
		});
	}
	datetime(options) {
		if (typeof options === "string") return this._addCheck({
			kind: "datetime",
			precision: null,
			offset: false,
			local: false,
			message: options
		});
		return this._addCheck({
			kind: "datetime",
			precision: typeof options?.precision === "undefined" ? null : options?.precision,
			offset: options?.offset ?? false,
			local: options?.local ?? false,
			...errorUtil.errToObj(options?.message)
		});
	}
	date(message) {
		return this._addCheck({
			kind: "date",
			message
		});
	}
	time(options) {
		if (typeof options === "string") return this._addCheck({
			kind: "time",
			precision: null,
			message: options
		});
		return this._addCheck({
			kind: "time",
			precision: typeof options?.precision === "undefined" ? null : options?.precision,
			...errorUtil.errToObj(options?.message)
		});
	}
	duration(message) {
		return this._addCheck({
			kind: "duration",
			...errorUtil.errToObj(message)
		});
	}
	regex(regex, message) {
		return this._addCheck({
			kind: "regex",
			regex,
			...errorUtil.errToObj(message)
		});
	}
	includes(value, options) {
		return this._addCheck({
			kind: "includes",
			value,
			position: options?.position,
			...errorUtil.errToObj(options?.message)
		});
	}
	startsWith(value, message) {
		return this._addCheck({
			kind: "startsWith",
			value,
			...errorUtil.errToObj(message)
		});
	}
	endsWith(value, message) {
		return this._addCheck({
			kind: "endsWith",
			value,
			...errorUtil.errToObj(message)
		});
	}
	min(minLength, message) {
		return this._addCheck({
			kind: "min",
			value: minLength,
			...errorUtil.errToObj(message)
		});
	}
	max(maxLength, message) {
		return this._addCheck({
			kind: "max",
			value: maxLength,
			...errorUtil.errToObj(message)
		});
	}
	length(len, message) {
		return this._addCheck({
			kind: "length",
			value: len,
			...errorUtil.errToObj(message)
		});
	}
	/**
	* Equivalent to `.min(1)`
	*/
	nonempty(message) {
		return this.min(1, errorUtil.errToObj(message));
	}
	trim() {
		return new ZodString({
			...this._def,
			checks: [...this._def.checks, { kind: "trim" }]
		});
	}
	toLowerCase() {
		return new ZodString({
			...this._def,
			checks: [...this._def.checks, { kind: "toLowerCase" }]
		});
	}
	toUpperCase() {
		return new ZodString({
			...this._def,
			checks: [...this._def.checks, { kind: "toUpperCase" }]
		});
	}
	get isDatetime() {
		return !!this._def.checks.find((ch) => ch.kind === "datetime");
	}
	get isDate() {
		return !!this._def.checks.find((ch) => ch.kind === "date");
	}
	get isTime() {
		return !!this._def.checks.find((ch) => ch.kind === "time");
	}
	get isDuration() {
		return !!this._def.checks.find((ch) => ch.kind === "duration");
	}
	get isEmail() {
		return !!this._def.checks.find((ch) => ch.kind === "email");
	}
	get isURL() {
		return !!this._def.checks.find((ch) => ch.kind === "url");
	}
	get isEmoji() {
		return !!this._def.checks.find((ch) => ch.kind === "emoji");
	}
	get isUUID() {
		return !!this._def.checks.find((ch) => ch.kind === "uuid");
	}
	get isNANOID() {
		return !!this._def.checks.find((ch) => ch.kind === "nanoid");
	}
	get isCUID() {
		return !!this._def.checks.find((ch) => ch.kind === "cuid");
	}
	get isCUID2() {
		return !!this._def.checks.find((ch) => ch.kind === "cuid2");
	}
	get isULID() {
		return !!this._def.checks.find((ch) => ch.kind === "ulid");
	}
	get isIP() {
		return !!this._def.checks.find((ch) => ch.kind === "ip");
	}
	get isCIDR() {
		return !!this._def.checks.find((ch) => ch.kind === "cidr");
	}
	get isBase64() {
		return !!this._def.checks.find((ch) => ch.kind === "base64");
	}
	get isBase64url() {
		return !!this._def.checks.find((ch) => ch.kind === "base64url");
	}
	get minLength() {
		let min = null;
		for (const ch of this._def.checks) if (ch.kind === "min") {
			if (min === null || ch.value > min) min = ch.value;
		}
		return min;
	}
	get maxLength() {
		let max = null;
		for (const ch of this._def.checks) if (ch.kind === "max") {
			if (max === null || ch.value < max) max = ch.value;
		}
		return max;
	}
};
ZodString.create = (params) => {
	return new ZodString({
		checks: [],
		typeName: ZodFirstPartyTypeKind.ZodString,
		coerce: params?.coerce ?? false,
		...processCreateParams(params)
	});
};
function floatSafeRemainder(val, step) {
	const valDecCount = (val.toString().split(".")[1] || "").length;
	const stepDecCount = (step.toString().split(".")[1] || "").length;
	const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
	return Number.parseInt(val.toFixed(decCount).replace(".", "")) % Number.parseInt(step.toFixed(decCount).replace(".", "")) / 10 ** decCount;
}
var ZodNumber = class ZodNumber extends ZodType {
	constructor() {
		super(...arguments);
		this.min = this.gte;
		this.max = this.lte;
		this.step = this.multipleOf;
	}
	_parse(input) {
		if (this._def.coerce) input.data = Number(input.data);
		if (this._getType(input) !== ZodParsedType.number) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.number,
				received: ctx.parsedType
			});
			return INVALID;
		}
		let ctx = void 0;
		const status = new ParseStatus();
		for (const check of this._def.checks) if (check.kind === "int") {
			if (!util.isInteger(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_type,
					expected: "integer",
					received: "float",
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "min") {
			if (check.inclusive ? input.data < check.value : input.data <= check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					minimum: check.value,
					type: "number",
					inclusive: check.inclusive,
					exact: false,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "max") {
			if (check.inclusive ? input.data > check.value : input.data >= check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					maximum: check.value,
					type: "number",
					inclusive: check.inclusive,
					exact: false,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "multipleOf") {
			if (floatSafeRemainder(input.data, check.value) !== 0) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.not_multiple_of,
					multipleOf: check.value,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "finite") {
			if (!Number.isFinite(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.not_finite,
					message: check.message
				});
				status.dirty();
			}
		} else util.assertNever(check);
		return {
			status: status.value,
			value: input.data
		};
	}
	gte(value, message) {
		return this.setLimit("min", value, true, errorUtil.toString(message));
	}
	gt(value, message) {
		return this.setLimit("min", value, false, errorUtil.toString(message));
	}
	lte(value, message) {
		return this.setLimit("max", value, true, errorUtil.toString(message));
	}
	lt(value, message) {
		return this.setLimit("max", value, false, errorUtil.toString(message));
	}
	setLimit(kind, value, inclusive, message) {
		return new ZodNumber({
			...this._def,
			checks: [...this._def.checks, {
				kind,
				value,
				inclusive,
				message: errorUtil.toString(message)
			}]
		});
	}
	_addCheck(check) {
		return new ZodNumber({
			...this._def,
			checks: [...this._def.checks, check]
		});
	}
	int(message) {
		return this._addCheck({
			kind: "int",
			message: errorUtil.toString(message)
		});
	}
	positive(message) {
		return this._addCheck({
			kind: "min",
			value: 0,
			inclusive: false,
			message: errorUtil.toString(message)
		});
	}
	negative(message) {
		return this._addCheck({
			kind: "max",
			value: 0,
			inclusive: false,
			message: errorUtil.toString(message)
		});
	}
	nonpositive(message) {
		return this._addCheck({
			kind: "max",
			value: 0,
			inclusive: true,
			message: errorUtil.toString(message)
		});
	}
	nonnegative(message) {
		return this._addCheck({
			kind: "min",
			value: 0,
			inclusive: true,
			message: errorUtil.toString(message)
		});
	}
	multipleOf(value, message) {
		return this._addCheck({
			kind: "multipleOf",
			value,
			message: errorUtil.toString(message)
		});
	}
	finite(message) {
		return this._addCheck({
			kind: "finite",
			message: errorUtil.toString(message)
		});
	}
	safe(message) {
		return this._addCheck({
			kind: "min",
			inclusive: true,
			value: Number.MIN_SAFE_INTEGER,
			message: errorUtil.toString(message)
		})._addCheck({
			kind: "max",
			inclusive: true,
			value: Number.MAX_SAFE_INTEGER,
			message: errorUtil.toString(message)
		});
	}
	get minValue() {
		let min = null;
		for (const ch of this._def.checks) if (ch.kind === "min") {
			if (min === null || ch.value > min) min = ch.value;
		}
		return min;
	}
	get maxValue() {
		let max = null;
		for (const ch of this._def.checks) if (ch.kind === "max") {
			if (max === null || ch.value < max) max = ch.value;
		}
		return max;
	}
	get isInt() {
		return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
	}
	get isFinite() {
		let max = null;
		let min = null;
		for (const ch of this._def.checks) if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") return true;
		else if (ch.kind === "min") {
			if (min === null || ch.value > min) min = ch.value;
		} else if (ch.kind === "max") {
			if (max === null || ch.value < max) max = ch.value;
		}
		return Number.isFinite(min) && Number.isFinite(max);
	}
};
ZodNumber.create = (params) => {
	return new ZodNumber({
		checks: [],
		typeName: ZodFirstPartyTypeKind.ZodNumber,
		coerce: params?.coerce || false,
		...processCreateParams(params)
	});
};
var ZodBigInt = class ZodBigInt extends ZodType {
	constructor() {
		super(...arguments);
		this.min = this.gte;
		this.max = this.lte;
	}
	_parse(input) {
		if (this._def.coerce) try {
			input.data = BigInt(input.data);
		} catch {
			return this._getInvalidInput(input);
		}
		if (this._getType(input) !== ZodParsedType.bigint) return this._getInvalidInput(input);
		let ctx = void 0;
		const status = new ParseStatus();
		for (const check of this._def.checks) if (check.kind === "min") {
			if (check.inclusive ? input.data < check.value : input.data <= check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					type: "bigint",
					minimum: check.value,
					inclusive: check.inclusive,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "max") {
			if (check.inclusive ? input.data > check.value : input.data >= check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					type: "bigint",
					maximum: check.value,
					inclusive: check.inclusive,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "multipleOf") {
			if (input.data % check.value !== BigInt(0)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.not_multiple_of,
					multipleOf: check.value,
					message: check.message
				});
				status.dirty();
			}
		} else util.assertNever(check);
		return {
			status: status.value,
			value: input.data
		};
	}
	_getInvalidInput(input) {
		const ctx = this._getOrReturnCtx(input);
		addIssueToContext(ctx, {
			code: ZodIssueCode.invalid_type,
			expected: ZodParsedType.bigint,
			received: ctx.parsedType
		});
		return INVALID;
	}
	gte(value, message) {
		return this.setLimit("min", value, true, errorUtil.toString(message));
	}
	gt(value, message) {
		return this.setLimit("min", value, false, errorUtil.toString(message));
	}
	lte(value, message) {
		return this.setLimit("max", value, true, errorUtil.toString(message));
	}
	lt(value, message) {
		return this.setLimit("max", value, false, errorUtil.toString(message));
	}
	setLimit(kind, value, inclusive, message) {
		return new ZodBigInt({
			...this._def,
			checks: [...this._def.checks, {
				kind,
				value,
				inclusive,
				message: errorUtil.toString(message)
			}]
		});
	}
	_addCheck(check) {
		return new ZodBigInt({
			...this._def,
			checks: [...this._def.checks, check]
		});
	}
	positive(message) {
		return this._addCheck({
			kind: "min",
			value: BigInt(0),
			inclusive: false,
			message: errorUtil.toString(message)
		});
	}
	negative(message) {
		return this._addCheck({
			kind: "max",
			value: BigInt(0),
			inclusive: false,
			message: errorUtil.toString(message)
		});
	}
	nonpositive(message) {
		return this._addCheck({
			kind: "max",
			value: BigInt(0),
			inclusive: true,
			message: errorUtil.toString(message)
		});
	}
	nonnegative(message) {
		return this._addCheck({
			kind: "min",
			value: BigInt(0),
			inclusive: true,
			message: errorUtil.toString(message)
		});
	}
	multipleOf(value, message) {
		return this._addCheck({
			kind: "multipleOf",
			value,
			message: errorUtil.toString(message)
		});
	}
	get minValue() {
		let min = null;
		for (const ch of this._def.checks) if (ch.kind === "min") {
			if (min === null || ch.value > min) min = ch.value;
		}
		return min;
	}
	get maxValue() {
		let max = null;
		for (const ch of this._def.checks) if (ch.kind === "max") {
			if (max === null || ch.value < max) max = ch.value;
		}
		return max;
	}
};
ZodBigInt.create = (params) => {
	return new ZodBigInt({
		checks: [],
		typeName: ZodFirstPartyTypeKind.ZodBigInt,
		coerce: params?.coerce ?? false,
		...processCreateParams(params)
	});
};
var ZodBoolean = class extends ZodType {
	_parse(input) {
		if (this._def.coerce) input.data = Boolean(input.data);
		if (this._getType(input) !== ZodParsedType.boolean) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.boolean,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK(input.data);
	}
};
ZodBoolean.create = (params) => {
	return new ZodBoolean({
		typeName: ZodFirstPartyTypeKind.ZodBoolean,
		coerce: params?.coerce || false,
		...processCreateParams(params)
	});
};
var ZodDate = class ZodDate extends ZodType {
	_parse(input) {
		if (this._def.coerce) input.data = new Date(input.data);
		if (this._getType(input) !== ZodParsedType.date) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.date,
				received: ctx.parsedType
			});
			return INVALID;
		}
		if (Number.isNaN(input.data.getTime())) {
			addIssueToContext(this._getOrReturnCtx(input), { code: ZodIssueCode.invalid_date });
			return INVALID;
		}
		const status = new ParseStatus();
		let ctx = void 0;
		for (const check of this._def.checks) if (check.kind === "min") {
			if (input.data.getTime() < check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					message: check.message,
					inclusive: true,
					exact: false,
					minimum: check.value,
					type: "date"
				});
				status.dirty();
			}
		} else if (check.kind === "max") {
			if (input.data.getTime() > check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					message: check.message,
					inclusive: true,
					exact: false,
					maximum: check.value,
					type: "date"
				});
				status.dirty();
			}
		} else util.assertNever(check);
		return {
			status: status.value,
			value: new Date(input.data.getTime())
		};
	}
	_addCheck(check) {
		return new ZodDate({
			...this._def,
			checks: [...this._def.checks, check]
		});
	}
	min(minDate, message) {
		return this._addCheck({
			kind: "min",
			value: minDate.getTime(),
			message: errorUtil.toString(message)
		});
	}
	max(maxDate, message) {
		return this._addCheck({
			kind: "max",
			value: maxDate.getTime(),
			message: errorUtil.toString(message)
		});
	}
	get minDate() {
		let min = null;
		for (const ch of this._def.checks) if (ch.kind === "min") {
			if (min === null || ch.value > min) min = ch.value;
		}
		return min != null ? new Date(min) : null;
	}
	get maxDate() {
		let max = null;
		for (const ch of this._def.checks) if (ch.kind === "max") {
			if (max === null || ch.value < max) max = ch.value;
		}
		return max != null ? new Date(max) : null;
	}
};
ZodDate.create = (params) => {
	return new ZodDate({
		checks: [],
		coerce: params?.coerce || false,
		typeName: ZodFirstPartyTypeKind.ZodDate,
		...processCreateParams(params)
	});
};
var ZodSymbol = class extends ZodType {
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.symbol) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.symbol,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK(input.data);
	}
};
ZodSymbol.create = (params) => {
	return new ZodSymbol({
		typeName: ZodFirstPartyTypeKind.ZodSymbol,
		...processCreateParams(params)
	});
};
var ZodUndefined = class extends ZodType {
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.undefined) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.undefined,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK(input.data);
	}
};
ZodUndefined.create = (params) => {
	return new ZodUndefined({
		typeName: ZodFirstPartyTypeKind.ZodUndefined,
		...processCreateParams(params)
	});
};
var ZodNull = class extends ZodType {
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.null) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.null,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK(input.data);
	}
};
ZodNull.create = (params) => {
	return new ZodNull({
		typeName: ZodFirstPartyTypeKind.ZodNull,
		...processCreateParams(params)
	});
};
var ZodAny = class extends ZodType {
	constructor() {
		super(...arguments);
		this._any = true;
	}
	_parse(input) {
		return OK(input.data);
	}
};
ZodAny.create = (params) => {
	return new ZodAny({
		typeName: ZodFirstPartyTypeKind.ZodAny,
		...processCreateParams(params)
	});
};
var ZodUnknown = class extends ZodType {
	constructor() {
		super(...arguments);
		this._unknown = true;
	}
	_parse(input) {
		return OK(input.data);
	}
};
ZodUnknown.create = (params) => {
	return new ZodUnknown({
		typeName: ZodFirstPartyTypeKind.ZodUnknown,
		...processCreateParams(params)
	});
};
var ZodNever = class extends ZodType {
	_parse(input) {
		const ctx = this._getOrReturnCtx(input);
		addIssueToContext(ctx, {
			code: ZodIssueCode.invalid_type,
			expected: ZodParsedType.never,
			received: ctx.parsedType
		});
		return INVALID;
	}
};
ZodNever.create = (params) => {
	return new ZodNever({
		typeName: ZodFirstPartyTypeKind.ZodNever,
		...processCreateParams(params)
	});
};
var ZodVoid = class extends ZodType {
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.undefined) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.void,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK(input.data);
	}
};
ZodVoid.create = (params) => {
	return new ZodVoid({
		typeName: ZodFirstPartyTypeKind.ZodVoid,
		...processCreateParams(params)
	});
};
var ZodArray = class ZodArray extends ZodType {
	_parse(input) {
		const { ctx, status } = this._processInputParams(input);
		const def = this._def;
		if (ctx.parsedType !== ZodParsedType.array) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.array,
				received: ctx.parsedType
			});
			return INVALID;
		}
		if (def.exactLength !== null) {
			const tooBig = ctx.data.length > def.exactLength.value;
			const tooSmall = ctx.data.length < def.exactLength.value;
			if (tooBig || tooSmall) {
				addIssueToContext(ctx, {
					code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
					minimum: tooSmall ? def.exactLength.value : void 0,
					maximum: tooBig ? def.exactLength.value : void 0,
					type: "array",
					inclusive: true,
					exact: true,
					message: def.exactLength.message
				});
				status.dirty();
			}
		}
		if (def.minLength !== null) {
			if (ctx.data.length < def.minLength.value) {
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					minimum: def.minLength.value,
					type: "array",
					inclusive: true,
					exact: false,
					message: def.minLength.message
				});
				status.dirty();
			}
		}
		if (def.maxLength !== null) {
			if (ctx.data.length > def.maxLength.value) {
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					maximum: def.maxLength.value,
					type: "array",
					inclusive: true,
					exact: false,
					message: def.maxLength.message
				});
				status.dirty();
			}
		}
		if (ctx.common.async) return Promise.all([...ctx.data].map((item, i) => {
			return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
		})).then((result) => {
			return ParseStatus.mergeArray(status, result);
		});
		const result = [...ctx.data].map((item, i) => {
			return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
		});
		return ParseStatus.mergeArray(status, result);
	}
	get element() {
		return this._def.type;
	}
	min(minLength, message) {
		return new ZodArray({
			...this._def,
			minLength: {
				value: minLength,
				message: errorUtil.toString(message)
			}
		});
	}
	max(maxLength, message) {
		return new ZodArray({
			...this._def,
			maxLength: {
				value: maxLength,
				message: errorUtil.toString(message)
			}
		});
	}
	length(len, message) {
		return new ZodArray({
			...this._def,
			exactLength: {
				value: len,
				message: errorUtil.toString(message)
			}
		});
	}
	nonempty(message) {
		return this.min(1, message);
	}
};
ZodArray.create = (schema, params) => {
	return new ZodArray({
		type: schema,
		minLength: null,
		maxLength: null,
		exactLength: null,
		typeName: ZodFirstPartyTypeKind.ZodArray,
		...processCreateParams(params)
	});
};
function deepPartialify(schema) {
	if (schema instanceof ZodObject) {
		const newShape = {};
		for (const key in schema.shape) {
			const fieldSchema = schema.shape[key];
			newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
		}
		return new ZodObject({
			...schema._def,
			shape: () => newShape
		});
	} else if (schema instanceof ZodArray) return new ZodArray({
		...schema._def,
		type: deepPartialify(schema.element)
	});
	else if (schema instanceof ZodOptional) return ZodOptional.create(deepPartialify(schema.unwrap()));
	else if (schema instanceof ZodNullable) return ZodNullable.create(deepPartialify(schema.unwrap()));
	else if (schema instanceof ZodTuple) return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
	else return schema;
}
var ZodObject = class ZodObject extends ZodType {
	constructor() {
		super(...arguments);
		this._cached = null;
		/**
		* @deprecated In most cases, this is no longer needed - unknown properties are now silently stripped.
		* If you want to pass through unknown properties, use `.passthrough()` instead.
		*/
		this.nonstrict = this.passthrough;
		/**
		* @deprecated Use `.extend` instead
		*  */
		this.augment = this.extend;
	}
	_getCached() {
		if (this._cached !== null) return this._cached;
		const shape = this._def.shape();
		const keys = util.objectKeys(shape);
		this._cached = {
			shape,
			keys
		};
		return this._cached;
	}
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.object) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.object,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const { status, ctx } = this._processInputParams(input);
		const { shape, keys: shapeKeys } = this._getCached();
		const extraKeys = [];
		if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
			for (const key in ctx.data) if (!shapeKeys.includes(key)) extraKeys.push(key);
		}
		const pairs = [];
		for (const key of shapeKeys) {
			const keyValidator = shape[key];
			const value = ctx.data[key];
			pairs.push({
				key: {
					status: "valid",
					value: key
				},
				value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
				alwaysSet: key in ctx.data
			});
		}
		if (this._def.catchall instanceof ZodNever) {
			const unknownKeys = this._def.unknownKeys;
			if (unknownKeys === "passthrough") for (const key of extraKeys) pairs.push({
				key: {
					status: "valid",
					value: key
				},
				value: {
					status: "valid",
					value: ctx.data[key]
				}
			});
			else if (unknownKeys === "strict") {
				if (extraKeys.length > 0) {
					addIssueToContext(ctx, {
						code: ZodIssueCode.unrecognized_keys,
						keys: extraKeys
					});
					status.dirty();
				}
			} else if (unknownKeys === "strip") {} else throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
		} else {
			const catchall = this._def.catchall;
			for (const key of extraKeys) {
				const value = ctx.data[key];
				pairs.push({
					key: {
						status: "valid",
						value: key
					},
					value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
					alwaysSet: key in ctx.data
				});
			}
		}
		if (ctx.common.async) return Promise.resolve().then(async () => {
			const syncPairs = [];
			for (const pair of pairs) {
				const key = await pair.key;
				const value = await pair.value;
				syncPairs.push({
					key,
					value,
					alwaysSet: pair.alwaysSet
				});
			}
			return syncPairs;
		}).then((syncPairs) => {
			return ParseStatus.mergeObjectSync(status, syncPairs);
		});
		else return ParseStatus.mergeObjectSync(status, pairs);
	}
	get shape() {
		return this._def.shape();
	}
	strict(message) {
		errorUtil.errToObj;
		return new ZodObject({
			...this._def,
			unknownKeys: "strict",
			...message !== void 0 ? { errorMap: (issue, ctx) => {
				const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
				if (issue.code === "unrecognized_keys") return { message: errorUtil.errToObj(message).message ?? defaultError };
				return { message: defaultError };
			} } : {}
		});
	}
	strip() {
		return new ZodObject({
			...this._def,
			unknownKeys: "strip"
		});
	}
	passthrough() {
		return new ZodObject({
			...this._def,
			unknownKeys: "passthrough"
		});
	}
	extend(augmentation) {
		return new ZodObject({
			...this._def,
			shape: () => ({
				...this._def.shape(),
				...augmentation
			})
		});
	}
	/**
	* Prior to zod@1.0.12 there was a bug in the
	* inferred type of merged objects. Please
	* upgrade if you are experiencing issues.
	*/
	merge(merging) {
		return new ZodObject({
			unknownKeys: merging._def.unknownKeys,
			catchall: merging._def.catchall,
			shape: () => ({
				...this._def.shape(),
				...merging._def.shape()
			}),
			typeName: ZodFirstPartyTypeKind.ZodObject
		});
	}
	setKey(key, schema) {
		return this.augment({ [key]: schema });
	}
	catchall(index) {
		return new ZodObject({
			...this._def,
			catchall: index
		});
	}
	pick(mask) {
		const shape = {};
		for (const key of util.objectKeys(mask)) if (mask[key] && this.shape[key]) shape[key] = this.shape[key];
		return new ZodObject({
			...this._def,
			shape: () => shape
		});
	}
	omit(mask) {
		const shape = {};
		for (const key of util.objectKeys(this.shape)) if (!mask[key]) shape[key] = this.shape[key];
		return new ZodObject({
			...this._def,
			shape: () => shape
		});
	}
	/**
	* @deprecated
	*/
	deepPartial() {
		return deepPartialify(this);
	}
	partial(mask) {
		const newShape = {};
		for (const key of util.objectKeys(this.shape)) {
			const fieldSchema = this.shape[key];
			if (mask && !mask[key]) newShape[key] = fieldSchema;
			else newShape[key] = fieldSchema.optional();
		}
		return new ZodObject({
			...this._def,
			shape: () => newShape
		});
	}
	required(mask) {
		const newShape = {};
		for (const key of util.objectKeys(this.shape)) if (mask && !mask[key]) newShape[key] = this.shape[key];
		else {
			let newField = this.shape[key];
			while (newField instanceof ZodOptional) newField = newField._def.innerType;
			newShape[key] = newField;
		}
		return new ZodObject({
			...this._def,
			shape: () => newShape
		});
	}
	keyof() {
		return createZodEnum(util.objectKeys(this.shape));
	}
};
ZodObject.create = (shape, params) => {
	return new ZodObject({
		shape: () => shape,
		unknownKeys: "strip",
		catchall: ZodNever.create(),
		typeName: ZodFirstPartyTypeKind.ZodObject,
		...processCreateParams(params)
	});
};
ZodObject.strictCreate = (shape, params) => {
	return new ZodObject({
		shape: () => shape,
		unknownKeys: "strict",
		catchall: ZodNever.create(),
		typeName: ZodFirstPartyTypeKind.ZodObject,
		...processCreateParams(params)
	});
};
ZodObject.lazycreate = (shape, params) => {
	return new ZodObject({
		shape,
		unknownKeys: "strip",
		catchall: ZodNever.create(),
		typeName: ZodFirstPartyTypeKind.ZodObject,
		...processCreateParams(params)
	});
};
var ZodUnion = class extends ZodType {
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		const options = this._def.options;
		function handleResults(results) {
			for (const result of results) if (result.result.status === "valid") return result.result;
			for (const result of results) if (result.result.status === "dirty") {
				ctx.common.issues.push(...result.ctx.common.issues);
				return result.result;
			}
			const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_union,
				unionErrors
			});
			return INVALID;
		}
		if (ctx.common.async) return Promise.all(options.map(async (option) => {
			const childCtx = {
				...ctx,
				common: {
					...ctx.common,
					issues: []
				},
				parent: null
			};
			return {
				result: await option._parseAsync({
					data: ctx.data,
					path: ctx.path,
					parent: childCtx
				}),
				ctx: childCtx
			};
		})).then(handleResults);
		else {
			let dirty = void 0;
			const issues = [];
			for (const option of options) {
				const childCtx = {
					...ctx,
					common: {
						...ctx.common,
						issues: []
					},
					parent: null
				};
				const result = option._parseSync({
					data: ctx.data,
					path: ctx.path,
					parent: childCtx
				});
				if (result.status === "valid") return result;
				else if (result.status === "dirty" && !dirty) dirty = {
					result,
					ctx: childCtx
				};
				if (childCtx.common.issues.length) issues.push(childCtx.common.issues);
			}
			if (dirty) {
				ctx.common.issues.push(...dirty.ctx.common.issues);
				return dirty.result;
			}
			const unionErrors = issues.map((issues) => new ZodError(issues));
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_union,
				unionErrors
			});
			return INVALID;
		}
	}
	get options() {
		return this._def.options;
	}
};
ZodUnion.create = (types, params) => {
	return new ZodUnion({
		options: types,
		typeName: ZodFirstPartyTypeKind.ZodUnion,
		...processCreateParams(params)
	});
};
var getDiscriminator = (type) => {
	if (type instanceof ZodLazy) return getDiscriminator(type.schema);
	else if (type instanceof ZodEffects) return getDiscriminator(type.innerType());
	else if (type instanceof ZodLiteral) return [type.value];
	else if (type instanceof ZodEnum) return type.options;
	else if (type instanceof ZodNativeEnum) return util.objectValues(type.enum);
	else if (type instanceof ZodDefault) return getDiscriminator(type._def.innerType);
	else if (type instanceof ZodUndefined) return [void 0];
	else if (type instanceof ZodNull) return [null];
	else if (type instanceof ZodOptional) return [void 0, ...getDiscriminator(type.unwrap())];
	else if (type instanceof ZodNullable) return [null, ...getDiscriminator(type.unwrap())];
	else if (type instanceof ZodBranded) return getDiscriminator(type.unwrap());
	else if (type instanceof ZodReadonly) return getDiscriminator(type.unwrap());
	else if (type instanceof ZodCatch) return getDiscriminator(type._def.innerType);
	else return [];
};
var ZodDiscriminatedUnion = class ZodDiscriminatedUnion extends ZodType {
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.object) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.object,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const discriminator = this.discriminator;
		const discriminatorValue = ctx.data[discriminator];
		const option = this.optionsMap.get(discriminatorValue);
		if (!option) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_union_discriminator,
				options: Array.from(this.optionsMap.keys()),
				path: [discriminator]
			});
			return INVALID;
		}
		if (ctx.common.async) return option._parseAsync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		});
		else return option._parseSync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		});
	}
	get discriminator() {
		return this._def.discriminator;
	}
	get options() {
		return this._def.options;
	}
	get optionsMap() {
		return this._def.optionsMap;
	}
	/**
	* The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
	* However, it only allows a union of objects, all of which need to share a discriminator property. This property must
	* have a different value for each object in the union.
	* @param discriminator the name of the discriminator property
	* @param types an array of object schemas
	* @param params
	*/
	static create(discriminator, options, params) {
		const optionsMap = /* @__PURE__ */ new Map();
		for (const type of options) {
			const discriminatorValues = getDiscriminator(type.shape[discriminator]);
			if (!discriminatorValues.length) throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
			for (const value of discriminatorValues) {
				if (optionsMap.has(value)) throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
				optionsMap.set(value, type);
			}
		}
		return new ZodDiscriminatedUnion({
			typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
			discriminator,
			options,
			optionsMap,
			...processCreateParams(params)
		});
	}
};
function mergeValues(a, b) {
	const aType = getParsedType(a);
	const bType = getParsedType(b);
	if (a === b) return {
		valid: true,
		data: a
	};
	else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
		const bKeys = util.objectKeys(b);
		const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		for (const key of sharedKeys) {
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return { valid: false };
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	} else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
		if (a.length !== b.length) return { valid: false };
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return { valid: false };
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	} else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) return {
		valid: true,
		data: a
	};
	else return { valid: false };
}
var ZodIntersection = class extends ZodType {
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		const handleParsed = (parsedLeft, parsedRight) => {
			if (isAborted(parsedLeft) || isAborted(parsedRight)) return INVALID;
			const merged = mergeValues(parsedLeft.value, parsedRight.value);
			if (!merged.valid) {
				addIssueToContext(ctx, { code: ZodIssueCode.invalid_intersection_types });
				return INVALID;
			}
			if (isDirty(parsedLeft) || isDirty(parsedRight)) status.dirty();
			return {
				status: status.value,
				value: merged.data
			};
		};
		if (ctx.common.async) return Promise.all([this._def.left._parseAsync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		}), this._def.right._parseAsync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		})]).then(([left, right]) => handleParsed(left, right));
		else return handleParsed(this._def.left._parseSync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		}), this._def.right._parseSync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		}));
	}
};
ZodIntersection.create = (left, right, params) => {
	return new ZodIntersection({
		left,
		right,
		typeName: ZodFirstPartyTypeKind.ZodIntersection,
		...processCreateParams(params)
	});
};
var ZodTuple = class ZodTuple extends ZodType {
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.array) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.array,
				received: ctx.parsedType
			});
			return INVALID;
		}
		if (ctx.data.length < this._def.items.length) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.too_small,
				minimum: this._def.items.length,
				inclusive: true,
				exact: false,
				type: "array"
			});
			return INVALID;
		}
		if (!this._def.rest && ctx.data.length > this._def.items.length) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.too_big,
				maximum: this._def.items.length,
				inclusive: true,
				exact: false,
				type: "array"
			});
			status.dirty();
		}
		const items = [...ctx.data].map((item, itemIndex) => {
			const schema = this._def.items[itemIndex] || this._def.rest;
			if (!schema) return null;
			return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
		}).filter((x) => !!x);
		if (ctx.common.async) return Promise.all(items).then((results) => {
			return ParseStatus.mergeArray(status, results);
		});
		else return ParseStatus.mergeArray(status, items);
	}
	get items() {
		return this._def.items;
	}
	rest(rest) {
		return new ZodTuple({
			...this._def,
			rest
		});
	}
};
ZodTuple.create = (schemas, params) => {
	if (!Array.isArray(schemas)) throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
	return new ZodTuple({
		items: schemas,
		typeName: ZodFirstPartyTypeKind.ZodTuple,
		rest: null,
		...processCreateParams(params)
	});
};
var ZodRecord = class ZodRecord extends ZodType {
	get keySchema() {
		return this._def.keyType;
	}
	get valueSchema() {
		return this._def.valueType;
	}
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.object) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.object,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const pairs = [];
		const keyType = this._def.keyType;
		const valueType = this._def.valueType;
		for (const key in ctx.data) pairs.push({
			key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
			value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
			alwaysSet: key in ctx.data
		});
		if (ctx.common.async) return ParseStatus.mergeObjectAsync(status, pairs);
		else return ParseStatus.mergeObjectSync(status, pairs);
	}
	get element() {
		return this._def.valueType;
	}
	static create(first, second, third) {
		if (second instanceof ZodType) return new ZodRecord({
			keyType: first,
			valueType: second,
			typeName: ZodFirstPartyTypeKind.ZodRecord,
			...processCreateParams(third)
		});
		return new ZodRecord({
			keyType: ZodString.create(),
			valueType: first,
			typeName: ZodFirstPartyTypeKind.ZodRecord,
			...processCreateParams(second)
		});
	}
};
var ZodMap = class extends ZodType {
	get keySchema() {
		return this._def.keyType;
	}
	get valueSchema() {
		return this._def.valueType;
	}
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.map) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.map,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const keyType = this._def.keyType;
		const valueType = this._def.valueType;
		const pairs = [...ctx.data.entries()].map(([key, value], index) => {
			return {
				key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
				value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
			};
		});
		if (ctx.common.async) {
			const finalMap = /* @__PURE__ */ new Map();
			return Promise.resolve().then(async () => {
				for (const pair of pairs) {
					const key = await pair.key;
					const value = await pair.value;
					if (key.status === "aborted" || value.status === "aborted") return INVALID;
					if (key.status === "dirty" || value.status === "dirty") status.dirty();
					finalMap.set(key.value, value.value);
				}
				return {
					status: status.value,
					value: finalMap
				};
			});
		} else {
			const finalMap = /* @__PURE__ */ new Map();
			for (const pair of pairs) {
				const key = pair.key;
				const value = pair.value;
				if (key.status === "aborted" || value.status === "aborted") return INVALID;
				if (key.status === "dirty" || value.status === "dirty") status.dirty();
				finalMap.set(key.value, value.value);
			}
			return {
				status: status.value,
				value: finalMap
			};
		}
	}
};
ZodMap.create = (keyType, valueType, params) => {
	return new ZodMap({
		valueType,
		keyType,
		typeName: ZodFirstPartyTypeKind.ZodMap,
		...processCreateParams(params)
	});
};
var ZodSet = class ZodSet extends ZodType {
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.set) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.set,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const def = this._def;
		if (def.minSize !== null) {
			if (ctx.data.size < def.minSize.value) {
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					minimum: def.minSize.value,
					type: "set",
					inclusive: true,
					exact: false,
					message: def.minSize.message
				});
				status.dirty();
			}
		}
		if (def.maxSize !== null) {
			if (ctx.data.size > def.maxSize.value) {
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					maximum: def.maxSize.value,
					type: "set",
					inclusive: true,
					exact: false,
					message: def.maxSize.message
				});
				status.dirty();
			}
		}
		const valueType = this._def.valueType;
		function finalizeSet(elements) {
			const parsedSet = /* @__PURE__ */ new Set();
			for (const element of elements) {
				if (element.status === "aborted") return INVALID;
				if (element.status === "dirty") status.dirty();
				parsedSet.add(element.value);
			}
			return {
				status: status.value,
				value: parsedSet
			};
		}
		const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
		if (ctx.common.async) return Promise.all(elements).then((elements) => finalizeSet(elements));
		else return finalizeSet(elements);
	}
	min(minSize, message) {
		return new ZodSet({
			...this._def,
			minSize: {
				value: minSize,
				message: errorUtil.toString(message)
			}
		});
	}
	max(maxSize, message) {
		return new ZodSet({
			...this._def,
			maxSize: {
				value: maxSize,
				message: errorUtil.toString(message)
			}
		});
	}
	size(size, message) {
		return this.min(size, message).max(size, message);
	}
	nonempty(message) {
		return this.min(1, message);
	}
};
ZodSet.create = (valueType, params) => {
	return new ZodSet({
		valueType,
		minSize: null,
		maxSize: null,
		typeName: ZodFirstPartyTypeKind.ZodSet,
		...processCreateParams(params)
	});
};
var ZodFunction = class ZodFunction extends ZodType {
	constructor() {
		super(...arguments);
		this.validate = this.implement;
	}
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.function) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.function,
				received: ctx.parsedType
			});
			return INVALID;
		}
		function makeArgsIssue(args, error) {
			return makeIssue({
				data: args,
				path: ctx.path,
				errorMaps: [
					ctx.common.contextualErrorMap,
					ctx.schemaErrorMap,
					getErrorMap(),
					errorMap
				].filter((x) => !!x),
				issueData: {
					code: ZodIssueCode.invalid_arguments,
					argumentsError: error
				}
			});
		}
		function makeReturnsIssue(returns, error) {
			return makeIssue({
				data: returns,
				path: ctx.path,
				errorMaps: [
					ctx.common.contextualErrorMap,
					ctx.schemaErrorMap,
					getErrorMap(),
					errorMap
				].filter((x) => !!x),
				issueData: {
					code: ZodIssueCode.invalid_return_type,
					returnTypeError: error
				}
			});
		}
		const params = { errorMap: ctx.common.contextualErrorMap };
		const fn = ctx.data;
		if (this._def.returns instanceof ZodPromise) {
			const me = this;
			return OK(async function(...args) {
				const error = new ZodError([]);
				const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
					error.addIssue(makeArgsIssue(args, e));
					throw error;
				});
				const result = await Reflect.apply(fn, this, parsedArgs);
				return await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
					error.addIssue(makeReturnsIssue(result, e));
					throw error;
				});
			});
		} else {
			const me = this;
			return OK(function(...args) {
				const parsedArgs = me._def.args.safeParse(args, params);
				if (!parsedArgs.success) throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
				const result = Reflect.apply(fn, this, parsedArgs.data);
				const parsedReturns = me._def.returns.safeParse(result, params);
				if (!parsedReturns.success) throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
				return parsedReturns.data;
			});
		}
	}
	parameters() {
		return this._def.args;
	}
	returnType() {
		return this._def.returns;
	}
	args(...items) {
		return new ZodFunction({
			...this._def,
			args: ZodTuple.create(items).rest(ZodUnknown.create())
		});
	}
	returns(returnType) {
		return new ZodFunction({
			...this._def,
			returns: returnType
		});
	}
	implement(func) {
		return this.parse(func);
	}
	strictImplement(func) {
		return this.parse(func);
	}
	static create(args, returns, params) {
		return new ZodFunction({
			args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
			returns: returns || ZodUnknown.create(),
			typeName: ZodFirstPartyTypeKind.ZodFunction,
			...processCreateParams(params)
		});
	}
};
var ZodLazy = class extends ZodType {
	get schema() {
		return this._def.getter();
	}
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		return this._def.getter()._parse({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		});
	}
};
ZodLazy.create = (getter, params) => {
	return new ZodLazy({
		getter,
		typeName: ZodFirstPartyTypeKind.ZodLazy,
		...processCreateParams(params)
	});
};
var ZodLiteral = class extends ZodType {
	_parse(input) {
		if (input.data !== this._def.value) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				received: ctx.data,
				code: ZodIssueCode.invalid_literal,
				expected: this._def.value
			});
			return INVALID;
		}
		return {
			status: "valid",
			value: input.data
		};
	}
	get value() {
		return this._def.value;
	}
};
ZodLiteral.create = (value, params) => {
	return new ZodLiteral({
		value,
		typeName: ZodFirstPartyTypeKind.ZodLiteral,
		...processCreateParams(params)
	});
};
function createZodEnum(values, params) {
	return new ZodEnum({
		values,
		typeName: ZodFirstPartyTypeKind.ZodEnum,
		...processCreateParams(params)
	});
}
var ZodEnum = class ZodEnum extends ZodType {
	_parse(input) {
		if (typeof input.data !== "string") {
			const ctx = this._getOrReturnCtx(input);
			const expectedValues = this._def.values;
			addIssueToContext(ctx, {
				expected: util.joinValues(expectedValues),
				received: ctx.parsedType,
				code: ZodIssueCode.invalid_type
			});
			return INVALID;
		}
		if (!this._cache) this._cache = new Set(this._def.values);
		if (!this._cache.has(input.data)) {
			const ctx = this._getOrReturnCtx(input);
			const expectedValues = this._def.values;
			addIssueToContext(ctx, {
				received: ctx.data,
				code: ZodIssueCode.invalid_enum_value,
				options: expectedValues
			});
			return INVALID;
		}
		return OK(input.data);
	}
	get options() {
		return this._def.values;
	}
	get enum() {
		const enumValues = {};
		for (const val of this._def.values) enumValues[val] = val;
		return enumValues;
	}
	get Values() {
		const enumValues = {};
		for (const val of this._def.values) enumValues[val] = val;
		return enumValues;
	}
	get Enum() {
		const enumValues = {};
		for (const val of this._def.values) enumValues[val] = val;
		return enumValues;
	}
	extract(values, newDef = this._def) {
		return ZodEnum.create(values, {
			...this._def,
			...newDef
		});
	}
	exclude(values, newDef = this._def) {
		return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
			...this._def,
			...newDef
		});
	}
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
	_parse(input) {
		const nativeEnumValues = util.getValidEnumValues(this._def.values);
		const ctx = this._getOrReturnCtx(input);
		if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
			const expectedValues = util.objectValues(nativeEnumValues);
			addIssueToContext(ctx, {
				expected: util.joinValues(expectedValues),
				received: ctx.parsedType,
				code: ZodIssueCode.invalid_type
			});
			return INVALID;
		}
		if (!this._cache) this._cache = new Set(util.getValidEnumValues(this._def.values));
		if (!this._cache.has(input.data)) {
			const expectedValues = util.objectValues(nativeEnumValues);
			addIssueToContext(ctx, {
				received: ctx.data,
				code: ZodIssueCode.invalid_enum_value,
				options: expectedValues
			});
			return INVALID;
		}
		return OK(input.data);
	}
	get enum() {
		return this._def.values;
	}
};
ZodNativeEnum.create = (values, params) => {
	return new ZodNativeEnum({
		values,
		typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
		...processCreateParams(params)
	});
};
var ZodPromise = class extends ZodType {
	unwrap() {
		return this._def.type;
	}
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.promise,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK((ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data)).then((data) => {
			return this._def.type.parseAsync(data, {
				path: ctx.path,
				errorMap: ctx.common.contextualErrorMap
			});
		}));
	}
};
ZodPromise.create = (schema, params) => {
	return new ZodPromise({
		type: schema,
		typeName: ZodFirstPartyTypeKind.ZodPromise,
		...processCreateParams(params)
	});
};
var ZodEffects = class extends ZodType {
	innerType() {
		return this._def.schema;
	}
	sourceType() {
		return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
	}
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		const effect = this._def.effect || null;
		const checkCtx = {
			addIssue: (arg) => {
				addIssueToContext(ctx, arg);
				if (arg.fatal) status.abort();
				else status.dirty();
			},
			get path() {
				return ctx.path;
			}
		};
		checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
		if (effect.type === "preprocess") {
			const processed = effect.transform(ctx.data, checkCtx);
			if (ctx.common.async) return Promise.resolve(processed).then(async (processed) => {
				if (status.value === "aborted") return INVALID;
				const result = await this._def.schema._parseAsync({
					data: processed,
					path: ctx.path,
					parent: ctx
				});
				if (result.status === "aborted") return INVALID;
				if (result.status === "dirty") return DIRTY(result.value);
				if (status.value === "dirty") return DIRTY(result.value);
				return result;
			});
			else {
				if (status.value === "aborted") return INVALID;
				const result = this._def.schema._parseSync({
					data: processed,
					path: ctx.path,
					parent: ctx
				});
				if (result.status === "aborted") return INVALID;
				if (result.status === "dirty") return DIRTY(result.value);
				if (status.value === "dirty") return DIRTY(result.value);
				return result;
			}
		}
		if (effect.type === "refinement") {
			const executeRefinement = (acc) => {
				const result = effect.refinement(acc, checkCtx);
				if (ctx.common.async) return Promise.resolve(result);
				if (result instanceof Promise) throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
				return acc;
			};
			if (ctx.common.async === false) {
				const inner = this._def.schema._parseSync({
					data: ctx.data,
					path: ctx.path,
					parent: ctx
				});
				if (inner.status === "aborted") return INVALID;
				if (inner.status === "dirty") status.dirty();
				executeRefinement(inner.value);
				return {
					status: status.value,
					value: inner.value
				};
			} else return this._def.schema._parseAsync({
				data: ctx.data,
				path: ctx.path,
				parent: ctx
			}).then((inner) => {
				if (inner.status === "aborted") return INVALID;
				if (inner.status === "dirty") status.dirty();
				return executeRefinement(inner.value).then(() => {
					return {
						status: status.value,
						value: inner.value
					};
				});
			});
		}
		if (effect.type === "transform") {
			if (ctx.common.async === false) {
				const base = this._def.schema._parseSync({
					data: ctx.data,
					path: ctx.path,
					parent: ctx
				});
				if (!isValid(base)) return INVALID;
				const result = effect.transform(base.value, checkCtx);
				if (result instanceof Promise) throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
				return {
					status: status.value,
					value: result
				};
			} else return this._def.schema._parseAsync({
				data: ctx.data,
				path: ctx.path,
				parent: ctx
			}).then((base) => {
				if (!isValid(base)) return INVALID;
				return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
					status: status.value,
					value: result
				}));
			});
		}
		util.assertNever(effect);
	}
};
ZodEffects.create = (schema, effect, params) => {
	return new ZodEffects({
		schema,
		typeName: ZodFirstPartyTypeKind.ZodEffects,
		effect,
		...processCreateParams(params)
	});
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
	return new ZodEffects({
		schema,
		effect: {
			type: "preprocess",
			transform: preprocess
		},
		typeName: ZodFirstPartyTypeKind.ZodEffects,
		...processCreateParams(params)
	});
};
var ZodOptional = class extends ZodType {
	_parse(input) {
		if (this._getType(input) === ZodParsedType.undefined) return OK(void 0);
		return this._def.innerType._parse(input);
	}
	unwrap() {
		return this._def.innerType;
	}
};
ZodOptional.create = (type, params) => {
	return new ZodOptional({
		innerType: type,
		typeName: ZodFirstPartyTypeKind.ZodOptional,
		...processCreateParams(params)
	});
};
var ZodNullable = class extends ZodType {
	_parse(input) {
		if (this._getType(input) === ZodParsedType.null) return OK(null);
		return this._def.innerType._parse(input);
	}
	unwrap() {
		return this._def.innerType;
	}
};
ZodNullable.create = (type, params) => {
	return new ZodNullable({
		innerType: type,
		typeName: ZodFirstPartyTypeKind.ZodNullable,
		...processCreateParams(params)
	});
};
var ZodDefault = class extends ZodType {
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		let data = ctx.data;
		if (ctx.parsedType === ZodParsedType.undefined) data = this._def.defaultValue();
		return this._def.innerType._parse({
			data,
			path: ctx.path,
			parent: ctx
		});
	}
	removeDefault() {
		return this._def.innerType;
	}
};
ZodDefault.create = (type, params) => {
	return new ZodDefault({
		innerType: type,
		typeName: ZodFirstPartyTypeKind.ZodDefault,
		defaultValue: typeof params.default === "function" ? params.default : () => params.default,
		...processCreateParams(params)
	});
};
var ZodCatch = class extends ZodType {
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		const newCtx = {
			...ctx,
			common: {
				...ctx.common,
				issues: []
			}
		};
		const result = this._def.innerType._parse({
			data: newCtx.data,
			path: newCtx.path,
			parent: { ...newCtx }
		});
		if (isAsync(result)) return result.then((result) => {
			return {
				status: "valid",
				value: result.status === "valid" ? result.value : this._def.catchValue({
					get error() {
						return new ZodError(newCtx.common.issues);
					},
					input: newCtx.data
				})
			};
		});
		else return {
			status: "valid",
			value: result.status === "valid" ? result.value : this._def.catchValue({
				get error() {
					return new ZodError(newCtx.common.issues);
				},
				input: newCtx.data
			})
		};
	}
	removeCatch() {
		return this._def.innerType;
	}
};
ZodCatch.create = (type, params) => {
	return new ZodCatch({
		innerType: type,
		typeName: ZodFirstPartyTypeKind.ZodCatch,
		catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
		...processCreateParams(params)
	});
};
var ZodNaN = class extends ZodType {
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.nan) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.nan,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return {
			status: "valid",
			value: input.data
		};
	}
};
ZodNaN.create = (params) => {
	return new ZodNaN({
		typeName: ZodFirstPartyTypeKind.ZodNaN,
		...processCreateParams(params)
	});
};
var ZodBranded = class extends ZodType {
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		const data = ctx.data;
		return this._def.type._parse({
			data,
			path: ctx.path,
			parent: ctx
		});
	}
	unwrap() {
		return this._def.type;
	}
};
var ZodPipeline = class ZodPipeline extends ZodType {
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		if (ctx.common.async) {
			const handleAsync = async () => {
				const inResult = await this._def.in._parseAsync({
					data: ctx.data,
					path: ctx.path,
					parent: ctx
				});
				if (inResult.status === "aborted") return INVALID;
				if (inResult.status === "dirty") {
					status.dirty();
					return DIRTY(inResult.value);
				} else return this._def.out._parseAsync({
					data: inResult.value,
					path: ctx.path,
					parent: ctx
				});
			};
			return handleAsync();
		} else {
			const inResult = this._def.in._parseSync({
				data: ctx.data,
				path: ctx.path,
				parent: ctx
			});
			if (inResult.status === "aborted") return INVALID;
			if (inResult.status === "dirty") {
				status.dirty();
				return {
					status: "dirty",
					value: inResult.value
				};
			} else return this._def.out._parseSync({
				data: inResult.value,
				path: ctx.path,
				parent: ctx
			});
		}
	}
	static create(a, b) {
		return new ZodPipeline({
			in: a,
			out: b,
			typeName: ZodFirstPartyTypeKind.ZodPipeline
		});
	}
};
var ZodReadonly = class extends ZodType {
	_parse(input) {
		const result = this._def.innerType._parse(input);
		const freeze = (data) => {
			if (isValid(data)) data.value = Object.freeze(data.value);
			return data;
		};
		return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
	}
	unwrap() {
		return this._def.innerType;
	}
};
ZodReadonly.create = (type, params) => {
	return new ZodReadonly({
		innerType: type,
		typeName: ZodFirstPartyTypeKind.ZodReadonly,
		...processCreateParams(params)
	});
};
ZodObject.lazycreate;
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind) {
	ZodFirstPartyTypeKind["ZodString"] = "ZodString";
	ZodFirstPartyTypeKind["ZodNumber"] = "ZodNumber";
	ZodFirstPartyTypeKind["ZodNaN"] = "ZodNaN";
	ZodFirstPartyTypeKind["ZodBigInt"] = "ZodBigInt";
	ZodFirstPartyTypeKind["ZodBoolean"] = "ZodBoolean";
	ZodFirstPartyTypeKind["ZodDate"] = "ZodDate";
	ZodFirstPartyTypeKind["ZodSymbol"] = "ZodSymbol";
	ZodFirstPartyTypeKind["ZodUndefined"] = "ZodUndefined";
	ZodFirstPartyTypeKind["ZodNull"] = "ZodNull";
	ZodFirstPartyTypeKind["ZodAny"] = "ZodAny";
	ZodFirstPartyTypeKind["ZodUnknown"] = "ZodUnknown";
	ZodFirstPartyTypeKind["ZodNever"] = "ZodNever";
	ZodFirstPartyTypeKind["ZodVoid"] = "ZodVoid";
	ZodFirstPartyTypeKind["ZodArray"] = "ZodArray";
	ZodFirstPartyTypeKind["ZodObject"] = "ZodObject";
	ZodFirstPartyTypeKind["ZodUnion"] = "ZodUnion";
	ZodFirstPartyTypeKind["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
	ZodFirstPartyTypeKind["ZodIntersection"] = "ZodIntersection";
	ZodFirstPartyTypeKind["ZodTuple"] = "ZodTuple";
	ZodFirstPartyTypeKind["ZodRecord"] = "ZodRecord";
	ZodFirstPartyTypeKind["ZodMap"] = "ZodMap";
	ZodFirstPartyTypeKind["ZodSet"] = "ZodSet";
	ZodFirstPartyTypeKind["ZodFunction"] = "ZodFunction";
	ZodFirstPartyTypeKind["ZodLazy"] = "ZodLazy";
	ZodFirstPartyTypeKind["ZodLiteral"] = "ZodLiteral";
	ZodFirstPartyTypeKind["ZodEnum"] = "ZodEnum";
	ZodFirstPartyTypeKind["ZodEffects"] = "ZodEffects";
	ZodFirstPartyTypeKind["ZodNativeEnum"] = "ZodNativeEnum";
	ZodFirstPartyTypeKind["ZodOptional"] = "ZodOptional";
	ZodFirstPartyTypeKind["ZodNullable"] = "ZodNullable";
	ZodFirstPartyTypeKind["ZodDefault"] = "ZodDefault";
	ZodFirstPartyTypeKind["ZodCatch"] = "ZodCatch";
	ZodFirstPartyTypeKind["ZodPromise"] = "ZodPromise";
	ZodFirstPartyTypeKind["ZodBranded"] = "ZodBranded";
	ZodFirstPartyTypeKind["ZodPipeline"] = "ZodPipeline";
	ZodFirstPartyTypeKind["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var stringType = ZodString.create;
var numberType = ZodNumber.create;
ZodNaN.create;
ZodBigInt.create;
var booleanType = ZodBoolean.create;
ZodDate.create;
ZodSymbol.create;
ZodUndefined.create;
ZodNull.create;
ZodAny.create;
ZodUnknown.create;
ZodNever.create;
ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
ZodObject.strictCreate;
var unionType = ZodUnion.create;
ZodDiscriminatedUnion.create;
ZodIntersection.create;
ZodTuple.create;
ZodRecord.create;
ZodMap.create;
ZodSet.create;
ZodFunction.create;
ZodLazy.create;
ZodLiteral.create;
var enumType = ZodEnum.create;
ZodNativeEnum.create;
ZodPromise.create;
ZodEffects.create;
ZodOptional.create;
ZodNullable.create;
ZodEffects.createWithPreprocess;
ZodPipeline.create;
// src/worker/lib/errors.ts
var AppError = class extends Error {
	status;
	code;
	details;
	constructor(status, code, message, details) {
		super(message ?? code);
		this.status = status;
		this.code = code;
		this.details = details;
	}
};
var forbidden = (code = "forbidden", msg = "Không có quyền") => new AppError(403, code, msg);
var notFound = (code = "not_found", msg = "Không tìm thấy") => new AppError(404, code, msg);
var conflict = (code, msg, d) => new AppError(409, code, msg, d);
/** Lỗi trả về client: không lộ stack/SQL ra ngoài. */
function onError(err, c) {
	const requestId = c.get("requestId");
	if (err instanceof AppError) return c.json({
		error: {
			code: err.code,
			message: err.message,
			details: err.details
		},
		requestId
	}, err.status);
	if (err instanceof ZodError) return c.json({
		error: {
			code: "validation_error",
			message: "Dữ liệu không hợp lệ",
			details: err.issues
		},
		requestId
	}, 422);
	const msg = String(err?.message ?? "");
	if (msg.includes("period_locked")) return c.json({
		error: {
			code: "period_locked",
			message: "Kỳ đã khoá sổ, chỉ được lập bút toán điều chỉnh ở kỳ sau"
		},
		requestId
	}, 423);
	if (msg.includes("CHECK constraint failed")) return c.json({
		error: {
			code: "constraint_violation",
			message: "Vi phạm ràng buộc dữ liệu (tồn kho có thể vừa thay đổi)"
		},
		requestId
	}, 409);
	console.error(JSON.stringify({
		level: "error",
		requestId,
		msg,
		stack: err?.stack
	}));
	return c.json({
		error: {
			code: "internal_error",
			message: "Lỗi hệ thống"
		},
		requestId
	}, 500);
}
// src/shop/worker/lib/util.ts
async function parseBody(c, schema) {
	let raw;
	try {
		raw = await c.req.json();
	} catch {
		throw new AppError(400, "invalid_json", "Nội dung gửi lên không phải JSON hợp lệ");
	}
	return schema.parse(raw);
}
/** Lỗi với mã HTTP ngoài danh sách của AppError (403/503...). */
var httpError = (status, code, message, details) => new AppError(status, code, message, details);
async function setting(db, key, fallback = "") {
	const r = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first();
	return r ? r.value : fallback;
}
async function settingNum(db, key, fallback) {
	const v = await setting(db, key, "");
	const n = Number(v);
	return v !== "" && Number.isFinite(n) ? n : fallback;
}
/** Cửa hàng xử lý đơn online (cửa hàng đang hoạt động đầu tiên). */
async function onlineStoreId(db) {
	return (await db.prepare(`SELECT id FROM stores WHERE active = 1 ORDER BY id LIMIT 1`).first())?.id ?? 1;
}
var clientIp = (c) => c.req.header("cf-connecting-ip") ?? "unknown";
/** Chuẩn hoá SĐT Việt Nam về dạng 0xxxxxxxxx; trả null nếu không hợp lệ. */
function normalizePhone(raw) {
	let s = raw.replace(/[\s.\-()]/g, "");
	if (s.startsWith("+84")) s = "0" + s.slice(3);
	else if (s.startsWith("84") && s.length >= 11) s = "0" + s.slice(2);
	return /^0\d{9,10}$/.test(s) ? s : null;
}
var maskPhone = (p) => {
	if (!p) return "";
	const d = p.replace(/\D/g, "");
	return d.length <= 4 ? d : "*".repeat(d.length - 4) + d.slice(-4);
};
var last4 = (p) => (p ?? "").replace(/\D/g, "").slice(-4);
var UNIT_LABEL = {
	kg: "kg",
	trai: "trái",
	khay: "khay",
	hop: "hộp",
	thung: "thùng",
	g: "g"
};
var unitLabel = (u) => UNIT_LABEL[u] ?? u;
var imageUrl = (key) => key ? `/img/${key}` : null;
function parseImages(json) {
	if (!json) return [];
	try {
		const a = JSON.parse(json);
		return Array.isArray(a) ? a.filter((x) => typeof x === "string" && (x.startsWith("products/") || x.startsWith("cms/"))) : [];
	} catch {
		return [];
	}
}
/** link_url banner: chỉ nhận đường dẫn nội bộ bắt đầu bằng "/" (chống open redirect). */
var safeLink = (u) => u && /^\/(?![\/\\])/.test(u) ? u : null;
var escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
var escapeLike = (s) => s.replace(/[\\%_]/g, (m) => "\\" + m);
function baseUrl(c) {
	return (c.env.SHOP_BASE_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
}
/** Job outbox với ref_id lấy theo mã đơn/tài khoản (cùng batch với việc tạo bản ghi). jobs type nằm ngoài union JobType của ERP. */
function enqueueByRef(db, type, refType, refCode, payload) {
	const sub = refType === "order" ? `(SELECT id FROM orders WHERE code = ?2)` : `(SELECT id FROM shop_accounts WHERE email = ?2)`;
	return db.prepare(`INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES (?1, '${refType}', ${sub}, ?3)`).bind(type, refCode, JSON.stringify(payload));
}
// src/shop/worker/lib/ratelimit.ts
/**
* Giới hạn tần suất theo IP bằng binding RATE_LIMITER (Workers Rate Limiting) nếu có; không có → bỏ qua.
* Nhóm khoá: auth (10/phút), checkout (20/phút), còn lại (120/phút) — mức cụ thể cấu hình ở binding;
* một binding chỉ có một ngưỡng nên tách bằng tiền tố khoá để ghép nhiều binding khi triển khai.
*/
var rateLimit = async (c, next) => {
	const rl = c.env.RATE_LIMITER;
	if (rl) {
		const p = c.req.path;
		const bucket = p.startsWith("/api/auth/") ? "auth" : p === "/api/checkout" ? "checkout" : "api";
		if (!(await rl.limit({ key: `${bucket}:${clientIp(c)}` })).success) throw httpError(429, "rate_limited", "Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút");
	}
	await next();
};
// node_modules/hono/dist/utils/cookie.js
var validCookieNameRegEx = /^[\w!#$%&'*.^`|~+-]+$/;
var relaxedCookieNameRegEx = /^[!#-:<>-[\]-~]+$/;
var validCookieValueRegEx = /^[ !#-:<-[\]-~]*$/;
var trimCookieWhitespace = (value) => {
	let start = 0;
	let end = value.length;
	while (start < end) {
		const charCode = value.charCodeAt(start);
		if (charCode !== 32 && charCode !== 9) break;
		start++;
	}
	while (end > start) {
		const charCode = value.charCodeAt(end - 1);
		if (charCode !== 32 && charCode !== 9) break;
		end--;
	}
	return start === 0 && end === value.length ? value : value.slice(start, end);
};
var parse = (cookie, name) => {
	if (name && cookie.indexOf(name) === -1) return {};
	const pairs = cookie.split(";");
	const parsedCookie = Object.create(null);
	for (const pairStr of pairs) {
		const valueStartPos = pairStr.indexOf("=");
		if (valueStartPos === -1) continue;
		const cookieName = trimCookieWhitespace(pairStr.substring(0, valueStartPos));
		if (name && name !== cookieName || !relaxedCookieNameRegEx.test(cookieName) || cookieName in parsedCookie) continue;
		let cookieValue = trimCookieWhitespace(pairStr.substring(valueStartPos + 1));
		if (cookieValue.length >= 2 && cookieValue.startsWith("\"") && cookieValue.endsWith("\"")) cookieValue = cookieValue.slice(1, -1);
		if (validCookieValueRegEx.test(cookieValue)) {
			parsedCookie[cookieName] = tryDecodeURIComponent(cookieValue);
			if (name) break;
		}
	}
	return parsedCookie;
};
var _serialize = (name, value, opt = {}) => {
	if (!validCookieNameRegEx.test(name)) throw new Error("Invalid cookie name");
	let cookie = `${name}=${value}`;
	if (/^__secure-/i.test(name) && !opt.secure) throw new Error("__Secure- Cookie must have Secure attributes");
	if (/^__host-/i.test(name)) {
		if (!opt.secure) throw new Error("__Host- Cookie must have Secure attributes");
		if (opt.path !== "/") throw new Error("__Host- Cookie must have Path attributes with \"/\"");
		if (opt.domain) throw new Error("__Host- Cookie must not have Domain attributes");
	}
	for (const key of [
		"domain",
		"path",
		"sameSite",
		"priority"
	]) if (opt[key] && /[;\r\n]/.test(opt[key])) throw new Error(`${key} must not contain ";", "\\r", or "\\n"`);
	if (opt && typeof opt.maxAge === "number" && opt.maxAge >= 0) {
		if (opt.maxAge > 3456e4) throw new Error("Cookies Max-Age SHOULD NOT be greater than 400 days (34560000 seconds) in duration.");
		cookie += `; Max-Age=${opt.maxAge | 0}`;
	}
	if (opt.domain && opt.prefix !== "host") cookie += `; Domain=${opt.domain}`;
	if (opt.path) cookie += `; Path=${opt.path}`;
	if (opt.expires) {
		if (opt.expires.getTime() - Date.now() > 3456e7) throw new Error("Cookies Expires SHOULD NOT be greater than 400 days (34560000 seconds) in the future.");
		cookie += `; Expires=${opt.expires.toUTCString()}`;
	}
	if (opt.httpOnly) cookie += "; HttpOnly";
	if (opt.secure) cookie += "; Secure";
	if (opt.sameSite) cookie += `; SameSite=${opt.sameSite.charAt(0).toUpperCase() + opt.sameSite.slice(1)}`;
	if (opt.priority) cookie += `; Priority=${opt.priority.charAt(0).toUpperCase() + opt.priority.slice(1)}`;
	if (opt.partitioned) {
		if (!opt.secure) throw new Error("Partitioned Cookie must have Secure attributes");
		cookie += "; Partitioned";
	}
	return cookie;
};
var serialize = (name, value, opt) => {
	value = encodeURIComponent(value);
	return _serialize(name, value, opt);
};
// node_modules/hono/dist/helper/cookie/index.js
var getCookie = (c, key, prefix) => {
	const cookie = c.req.raw.headers.get("Cookie");
	if (typeof key === "string") {
		if (!cookie) return;
		let finalKey = key;
		if (prefix === "secure") finalKey = "__Secure-" + key;
		else if (prefix === "host") finalKey = "__Host-" + key;
		return parse(cookie, finalKey)[finalKey];
	}
	if (!cookie) return {};
	return parse(cookie);
};
var generateCookie = (name, value, opt) => {
	let cookie;
	if (opt?.prefix === "secure") cookie = serialize("__Secure-" + name, value, {
		path: "/",
		...opt,
		secure: true
	});
	else if (opt?.prefix === "host") cookie = serialize("__Host-" + name, value, {
		...opt,
		path: "/",
		secure: true,
		domain: void 0
	});
	else cookie = serialize(name, value, {
		path: "/",
		...opt
	});
	return cookie;
};
var setCookie = (c, name, value, opt) => {
	const cookie = generateCookie(name, value, opt);
	c.header("Set-Cookie", cookie, { append: true });
};
var deleteCookie = (c, name, opt) => {
	const deletedCookie = getCookie(c, name, opt?.prefix);
	setCookie(c, name, "", {
		...opt,
		maxAge: 0
	});
	return deletedCookie;
};
// src/worker/lib/crypto.ts
var ITER = 1e5;
var enc = new TextEncoder();
var b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
var unb64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
async function derive(password, salt, iter) {
	const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
	return crypto.subtle.deriveBits({
		name: "PBKDF2",
		hash: "SHA-256",
		salt,
		iterations: iter
	}, key, 256);
}
async function hashPassword(password) {
	const salt = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(16));
	return `pbkdf2$${ITER}$${b64(salt)}$${b64(await derive(password, salt, ITER))}`;
}
async function verifyPassword(password, stored) {
	const [alg, iterS, saltS, hashS] = stored.split("$");
	if (alg !== "pbkdf2" || !iterS || !saltS || !hashS) return false;
	return timingSafeEqual(new Uint8Array(await derive(password, unb64(saltS), Number(iterS))), unb64(hashS));
}
function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
	return r === 0;
}
function randomToken(bytes = 32) {
	return b64(crypto.getRandomValues(new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function sha256(s) {
	const h = await crypto.subtle.digest("SHA-256", enc.encode(s));
	return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
// src/shop/worker/lib/session.ts
var SESSION_COOKIE = "__Host-hm_shop";
function sessionTokenOf(c) {
	const h = c.req.header("authorization");
	if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || null;
	return getCookie(c, "__Host-hm_shop") ?? null;
}
async function loadAccount(env, token) {
	const id = await sha256(token);
	const r = await env.DB.prepare(`SELECT a.id, a.customer_id, a.email, a.phone, a.full_name, a.kind, a.b2b_status, a.marketing_opt_in, a.email_verified_at,
            cu.customer_group_id, cg.code AS group_code
       FROM shop_sessions s
       JOIN shop_accounts a ON a.id = s.account_id
       JOIN customers cu ON cu.id = a.customer_id
       LEFT JOIN customer_groups cg ON cg.id = cu.customer_group_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.active = 1 AND a.deleted_at IS NULL`).bind(id, (/* @__PURE__ */ new Date()).toISOString()).first();
	if (!r) return null;
	return {
		id: r.id,
		customerId: r.customer_id,
		email: r.email,
		phone: r.phone,
		fullName: r.full_name,
		kind: r.kind,
		b2bStatus: r.b2b_status,
		marketingOptIn: !!r.marketing_opt_in,
		emailVerified: !!r.email_verified_at,
		customerGroupId: r.customer_group_id,
		customerGroup: r.group_code,
		sessionId: id
	};
}
/** Nạp tài khoản nếu có phiên hợp lệ; không bắt buộc đăng nhập. */
var optionalAuth = async (c, next) => {
	const t = sessionTokenOf(c);
	c.set("account", t ? await loadAccount(c.env, t) : null);
	await next();
};
var requireAccount = async (c, next) => {
	const t = sessionTokenOf(c);
	const a = t ? await loadAccount(c.env, t) : null;
	if (!a) throw new AppError(401, "unauthenticated", "Vui lòng đăng nhập");
	c.set("account", a);
	await next();
};
var requireB2b = async (c, next) => {
	const a = c.get("account");
	if (!a || a.kind !== "b2b" || a.b2bStatus !== "approved") throw new AppError(403, "b2b_not_approved", "Tài khoản chưa được duyệt là khách sỉ");
	await next();
};
/**
* CSRF: request ghi (không phải GET/HEAD/OPTIONS) mang cookie phiên phải có header X-Requested-With: hm-shop.
* (Header tuỳ biến buộc trình duyệt gửi preflight CORS; origin khác không qua được.) Bearer (app native) không cần.
*/
var csrfGuard = async (c, next) => {
	const m = c.req.method;
	if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && !c.req.header("authorization") && getCookie(c, "__Host-hm_shop")) {
		if (c.req.header("x-requested-with") !== "hm-shop") throw new AppError(403, "csrf", "Yêu cầu không hợp lệ (thiếu header X-Requested-With)");
	}
	await next();
};
// src/worker/lib/time.ts
var VN_OFFSET_MS = 252e5;
var vnDate = (d = /* @__PURE__ */ new Date()) => new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
var vnDay = (d = /* @__PURE__ */ new Date()) => vnDate(d).replaceAll("-", "");
// src/worker/lib/codes.ts
/** Sinh mã chứng từ tăng dần theo ngày, nguyên tử trên D1: HD-20261123-0001 */
async function nextCode(db, prefix) {
	const day = vnDay();
	const row = await db.prepare(`INSERT INTO doc_sequences(prefix, day, seq) VALUES (?1, ?2, 1)
       ON CONFLICT(prefix, day) DO UPDATE SET seq = seq + 1 RETURNING seq`).bind(prefix, day).first();
	return `${prefix}-${day}-${String(row.seq).padStart(4, "0")}`;
}
// src/worker/services/sysaudit.ts
function sysAuditStmt(db, e, userId = null) {
	return db.prepare(`INSERT INTO audit_log(user_id, action, entity, entity_id, before_json, after_json, reason) VALUES (?,?,?,?,?,?,?)`).bind(userId, e.action, e.entity ?? null, e.entityId != null ? String(e.entityId) : null, e.before !== void 0 ? JSON.stringify(e.before) : null, e.after !== void 0 ? JSON.stringify(e.after) : null, e.reason ?? null);
}
// src/shop/worker/lib/turnstile.ts
var VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/**
* Xác minh Cloudflare Turnstile (header X-Turnstile-Token).
*  - Chưa có TURNSTILE_SECRET: APP_ENV=dev → bỏ qua; môi trường khác → 503 turnstile_not_configured.
*  - Thiếu token / xác minh thất bại / lỗi mạng → 403 turnstile_failed.
*/
async function verifyTurnstile(c) {
	const env = c.env;
	if (!env.TURNSTILE_SECRET) {
		if (env.APP_ENV === "dev") return;
		throw httpError(503, "turnstile_not_configured", "Hệ thống xác thực chống bot chưa được cấu hình");
	}
	const token = c.req.header("x-turnstile-token");
	if (!token || token.length > 2048) throw httpError(403, "turnstile_failed", "Vui lòng xác nhận bạn không phải robot");
	let ok = false;
	try {
		const form = new URLSearchParams({
			secret: env.TURNSTILE_SECRET,
			response: token
		});
		const ip = clientIp(c);
		if (ip !== "unknown") form.set("remoteip", ip);
		const res = await fetch(VERIFY_URL, {
			method: "POST",
			body: form
		});
		if (res.ok) ok = (await res.json()).success === true;
	} catch {
		ok = false;
	}
	if (!ok) throw httpError(403, "turnstile_failed", "Xác minh chống robot không thành công, vui lòng thử lại");
}
// src/shop/worker/routes/auth.ts
var authRoutes = new Hono();
var MAX_FAILS = 5;
var LOCK_MINUTES = 15;
var TOKEN_TTL_MS = 36e5;
var DUMMY_HASH = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
var Email = stringType().trim().toLowerCase().email().max(200);
var Password = stringType().min(8, "Mật khẩu tối thiểu 8 ký tự").max(128);
var GENERIC_OK = {
	ok: true,
	message: "Nếu thông tin hợp lệ, chúng tôi đã gửi email hướng dẫn."
};
var meShape = (a) => ({
	id: a.id,
	fullName: a.fullName,
	email: a.email,
	phone: a.phone,
	kind: a.kind,
	b2bStatus: a.b2bStatus,
	customerGroup: a.customerGroup,
	marketingOptIn: a.marketingOptIn
});
async function startSession(c, accountId) {
	const token = randomToken(32);
	const exp = new Date(Date.now() + 2592e6).toISOString();
	await c.env.DB.prepare(`INSERT INTO shop_sessions(id, account_id, ip, user_agent, expires_at) VALUES (?,?,?,?,?)`).bind(await sha256(token), accountId, clientIp(c), (c.req.header("user-agent") ?? "").slice(0, 200), exp).run();
	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: 2592e3
	});
	return token;
}
/** Tạo token một lần (lưu SHA-256), trả token gốc CHỈ để đưa vào link trong payload job email — không ghi log/audit. */
async function issueToken(db, accountId, purpose) {
	const token = randomToken(32);
	return {
		token,
		stmt: db.prepare(`INSERT INTO shop_tokens(id, account_id, purpose, expires_at) VALUES (?,?,?,?)`).bind(await sha256(token), accountId, purpose, new Date(Date.now() + TOKEN_TTL_MS).toISOString())
	};
}
authRoutes.post("/register", async (c) => {
	await verifyTurnstile(c);
	const b = await parseBody(c, objectType({
		fullName: stringType().trim().min(1).max(100),
		email: Email,
		phone: stringType().trim().min(8).max(20),
		password: Password,
		marketingOptIn: booleanType().optional()
	}));
	const phone = normalizePhone(b.phone);
	if (!phone) throw new AppError(422, "invalid_phone", "Số điện thoại không hợp lệ");
	const db = c.env.DB;
	if (await db.prepare(`SELECT id FROM shop_accounts WHERE email = ?`).bind(b.email).first()) {
		await hashPassword(b.password);
		return c.json(GENERIC_OK, 201);
	}
	const groupId = (await db.prepare(`SELECT id FROM customer_groups WHERE code = 'le'`).first())?.id ?? null;
	const ccode = await nextCode(db, "KL");
	const passHash = await hashPassword(b.password);
	const token = randomToken(32);
	const tokenId = await sha256(token);
	try {
		await db.batch([
			db.prepare(`INSERT INTO customers(code, type, name, phone, email, customer_group_id, created_at) VALUES (?, 'retail', ?, ?, ?, ?, ?)`).bind(ccode, b.fullName, phone, b.email, groupId, (/* @__PURE__ */ new Date()).toISOString()),
			db.prepare(`INSERT INTO shop_accounts(customer_id, email, phone, full_name, pass_hash, kind, marketing_opt_in) VALUES ((SELECT id FROM customers WHERE code = ?), ?, ?, ?, ?, 'retail', ?)`).bind(ccode, b.email, phone, b.fullName, passHash, b.marketingOptIn ? 1 : 0),
			db.prepare(`INSERT INTO shop_tokens(id, account_id, purpose, expires_at) VALUES (?, (SELECT id FROM shop_accounts WHERE email = ?), 'verify_email', ?)`).bind(tokenId, b.email, new Date(Date.now() + TOKEN_TTL_MS).toISOString()),
			enqueueByRef(db, "notify.email", "shop_account", b.email, {
				to: b.email,
				template: "verify_email",
				link: `${baseUrl(c)}/verify-email?token=${token}`
			})
		]);
	} catch (e) {
		if (/UNIQUE constraint failed/i.test(String(e?.message))) return c.json(GENERIC_OK, 201);
		throw e;
	}
	return c.json(GENERIC_OK, 201);
});
authRoutes.post("/login", async (c) => {
	await verifyTurnstile(c);
	const b = await parseBody(c, objectType({
		email: Email,
		password: stringType().min(1).max(128)
	}));
	const db = c.env.DB;
	const u = await db.prepare(`SELECT id, pass_hash, active, failed_logins, locked_until FROM shop_accounts WHERE email = ? AND deleted_at IS NULL`).bind(b.email).first();
	const now = /* @__PURE__ */ new Date();
	if (u?.locked_until && u.locked_until > now.toISOString()) throw new AppError(429, "account_locked", "Đăng nhập sai quá nhiều lần, vui lòng thử lại sau 15 phút");
	const ok = await verifyPassword(b.password, u?.pass_hash ?? DUMMY_HASH);
	if (!u || !ok || !u.active) {
		if (u) {
			const fails = u.failed_logins + 1;
			const lock = fails >= MAX_FAILS ? new Date(now.getTime() + LOCK_MINUTES * 6e4).toISOString() : null;
			await db.prepare(`UPDATE shop_accounts SET failed_logins = ?, locked_until = ? WHERE id = ?`).bind(lock ? 0 : fails, lock, u.id).run();
		}
		throw new AppError(401, "invalid_credentials", "Email hoặc mật khẩu không đúng");
	}
	const old = sessionTokenOf(c);
	const stmts = [db.prepare(`UPDATE shop_accounts SET failed_logins = 0, locked_until = NULL WHERE id = ?`).bind(u.id)];
	if (old) stmts.push(db.prepare(`UPDATE shop_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(now.toISOString(), await sha256(old)));
	await db.batch(stmts);
	const token = await startSession(c, u.id);
	const acc = await loadAccount(c.env, token);
	return c.json({
		account: meShape(acc),
		...c.req.header("x-client") === "native" ? { token } : {}
	});
});
authRoutes.post("/logout", async (c) => {
	const t = sessionTokenOf(c);
	if (t) await c.env.DB.prepare(`UPDATE shop_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind((/* @__PURE__ */ new Date()).toISOString(), await sha256(t)).run();
	deleteCookie(c, SESSION_COOKIE, {
		path: "/",
		secure: true
	});
	return c.json({ ok: true });
});
authRoutes.post("/forgot", async (c) => {
	await verifyTurnstile(c);
	const b = await parseBody(c, objectType({ email: Email }));
	const db = c.env.DB;
	const u = await db.prepare(`SELECT id FROM shop_accounts WHERE email = ? AND active = 1 AND deleted_at IS NULL`).bind(b.email).first();
	if (u) {
		const { token, stmt } = await issueToken(db, u.id, "reset_password");
		await db.batch([stmt, enqueueByRef(db, "notify.email", "shop_account", b.email, {
			to: b.email,
			template: "reset_password",
			link: `${baseUrl(c)}/reset-password?token=${token}`
		})]);
	} else await hashPassword("x");
	return c.json(GENERIC_OK);
});
/** Dùng token một lần: đánh dấu used_at có điều kiện (an toàn khi hai request cùng lúc). */
async function consumeToken(db, token, purpose) {
	const id = await sha256(token);
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const r = await db.prepare(`UPDATE shop_tokens SET used_at = ? WHERE id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? RETURNING account_id`).bind(now, id, purpose, now).first();
	if (!r) throw new AppError(400, "invalid_token", "Liên kết không hợp lệ hoặc đã hết hạn");
	return r.account_id;
}
authRoutes.post("/reset", async (c) => {
	const b = await parseBody(c, objectType({
		token: stringType().min(10).max(200),
		password: Password
	}));
	const db = c.env.DB;
	const accountId = await consumeToken(db, b.token, "reset_password");
	const hash = await hashPassword(b.password);
	await db.batch([
		db.prepare(`UPDATE shop_accounts SET pass_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ? AND deleted_at IS NULL`).bind(hash, accountId),
		db.prepare(`UPDATE shop_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`).bind((/* @__PURE__ */ new Date()).toISOString(), accountId),
		sysAuditStmt(db, {
			action: "shop.password_reset",
			entity: "shop_account",
			entityId: accountId
		})
	]);
	return c.json({ ok: true });
});
authRoutes.post("/verify-email", async (c) => {
	const b = await parseBody(c, objectType({ token: stringType().min(10).max(200) }));
	const accountId = await consumeToken(c.env.DB, b.token, "verify_email");
	await c.env.DB.prepare(`UPDATE shop_accounts SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`).bind((/* @__PURE__ */ new Date()).toISOString(), accountId).run();
	return c.json({ ok: true });
});
// src/worker/services/debt.ts
/**
* Mô hình công nợ (nguồn sự thật cho M4/M5/báo cáo):
*  - Hoá đơn bán `invoices` kind='sale'|'replacement' là khoản phải thu. Hoá đơn kind='adjustment' (tổng âm hoặc dương)
*    trỏ original_invoice_id và cộng vào khoản gốc — không phải dòng nợ riêng.
*  - Còn nợ của 1 hoá đơn = total + Σ total các hoá đơn điều chỉnh của nó − Σ debt_allocations.amount
*    (chỉ allocations của payment/adjustment còn status 'posted' — phiếu đã đảo không còn tác dụng).
*  - Số dư khách = Σ còn nợ các hoá đơn open − tiền đã trả chưa gạch (số dư có, EC-24).
*  - Phải trả NCC: tương tự với supplier_bills (không có hoá đơn điều chỉnh; điều chỉnh bằng debt_adjustments).
* Tất cả là SQL thuần để dùng được trong báo cáo.
*/
/** Biểu thức SQL: số còn nợ của hoá đơn alias `i`. */
var INVOICE_OUTSTANDING_SQL = `(i.total
  + COALESCE((SELECT SUM(a.total) FROM invoices a WHERE a.original_invoice_id = i.id AND a.kind = 'adjustment' AND a.status = 'open'), 0)
  - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x
               LEFT JOIN debt_payments xp ON xp.id = x.payment_id
               LEFT JOIN debt_adjustments xd ON xd.id = x.adjustment_id
              WHERE x.invoice_id = i.id AND (xp.status = 'posted' OR xd.status = 'posted')), 0))`;
async function customerDebtStatus(db, customerId, today = vnDate()) {
	const r = await db.prepare(`WITH inv AS (
         SELECT i.id, i.due_date, ${INVOICE_OUTSTANDING_SQL} AS os
           FROM invoices i
          WHERE i.customer_id = ?1 AND i.status = 'open' AND i.kind IN ('sale','replacement')
       )
       SELECT
         COALESCE((SELECT SUM(os) FROM inv WHERE os > 0), 0) AS outstanding,
         COALESCE((SELECT SUM(os) FROM inv WHERE os > 0 AND due_date < ?2), 0) AS overdue_amount,
         (SELECT COUNT(*) FROM inv WHERE os > 0 AND due_date < ?2) AS overdue_count,
         COALESCE((SELECT MIN(due_date) FROM inv WHERE os > 0 AND due_date < ?2), NULL) AS oldest_due,
         COALESCE((SELECT SUM(p.amount) - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x JOIN debt_payments p2 ON p2.id = x.payment_id
                                                     WHERE p2.partner_type='customer' AND p2.partner_id=?1 AND p2.direction='in' AND p2.status='posted'), 0)
                     FROM debt_payments p WHERE p.partner_type='customer' AND p.partner_id=?1 AND p.direction='in' AND p.status='posted'), 0) AS unapplied_pay,
         COALESCE((SELECT SUM(d.amount) - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x JOIN debt_adjustments d2 ON d2.id = x.adjustment_id
                                                     WHERE d2.partner_type='customer' AND d2.partner_id=?1 AND d2.status='posted'), 0)
                     FROM debt_adjustments d WHERE d.partner_type='customer' AND d.partner_id=?1 AND d.status='posted'), 0) AS unapplied_adj,
         (SELECT credit_limit FROM customers WHERE id = ?1) AS credit_limit`).bind(customerId, today).first();
	const outstanding = r?.outstanding ?? 0;
	const unapplied = (r?.unapplied_pay ?? 0) + (r?.unapplied_adj ?? 0);
	const balance = outstanding - unapplied;
	const creditLimit = r?.credit_limit ?? 0;
	const oldestOverdueDays = r?.oldest_due ? Math.round((Date.parse(today) - Date.parse(r.oldest_due)) / 864e5) : 0;
	return {
		balance,
		outstanding,
		unapplied,
		overdueAmount: r?.overdue_amount ?? 0,
		overdueCount: r?.overdue_count ?? 0,
		oldestOverdueDays,
		creditLimit,
		available: creditLimit - balance
	};
}
/**
* Kiểm tra hạn mức trước khi tạo/giữ hàng đơn sỉ (EC-23, M4-04, M5-05):
* chặn nếu có nợ quá hạn hoặc balance + giá trị đơn mới > hạn mức. Chỉ chủ (b2b.credit_override) duyệt tay.
*/
async function checkCredit(db, customerId, newOrderAmount) {
	const s = await customerDebtStatus(db, customerId);
	const reasons = [];
	if (s.overdueCount > 0) reasons.push("overdue");
	if (s.balance + newOrderAmount > s.creditLimit) reasons.push("over_limit");
	return {
		ok: reasons.length === 0,
		reasons,
		status: s
	};
}
// src/worker/lib/audit.ts
/** Trả về statement để gộp vào cùng D1 batch với thay đổi nghiệp vụ (cùng commit / cùng rollback). */
function auditStmt(c, e, userId) {
	const u = c.get("user");
	return c.env.DB.prepare(`INSERT INTO audit_log(user_id, action, entity, entity_id, before_json, after_json, reason, ip, device_id, request_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(userId ?? u?.id ?? null, e.action, e.entity ?? null, e.entityId != null ? String(e.entityId) : null, e.before !== void 0 ? JSON.stringify(e.before) : null, e.after !== void 0 ? JSON.stringify(e.after) : null, e.reason ?? null, c.req.header("cf-connecting-ip") ?? null, u?.deviceId ?? c.req.header("x-device-id") ?? null, c.get("requestId") ?? null);
}
// src/worker/lib/money.ts
/** Thành tiền = đơn giá (VND / đơn vị chính) × số lượng milli / 1000, làm tròn tới đồng. */
var lineAmount = (unitPrice, qtyMilli) => Math.round(unitPrice * qtyMilli / 1e3);
var ROLE_PERMS = {
	owner: /* @__PURE__ */ new Set([
		"pos.sell",
		"pos.void",
		"pos.return",
		"pos.shift",
		"orders.view",
		"orders.online.manage",
		"inventory.view",
		"inventory.write",
		"inventory.approve",
		"products.write",
		"prices.view_sell",
		"prices.view_cost",
		"prices.write",
		"prices.approve",
		"finance.view",
		"finance.write",
		"finance.approve",
		"finance.shift_reconcile",
		"finance.lock_period",
		"b2b.view",
		"b2b.write",
		"b2b.approve",
		"b2b.credit_override",
		"b2b.deliver",
		"debt.view",
		"debt.write",
		"debt.approve",
		"invoices.issue",
		"integrations.manage",
		"reports.view",
		"customers.view_pii",
		"users.manage",
		"audit.view",
		"approvals.decide"
	]),
	manager: /* @__PURE__ */ new Set([
		"pos.sell",
		"pos.void",
		"pos.return",
		"pos.shift",
		"orders.view",
		"orders.online.manage",
		"inventory.view",
		"inventory.write",
		"inventory.approve",
		"products.write",
		"prices.view_sell",
		"prices.view_cost",
		"prices.write",
		"prices.approve",
		"finance.view",
		"finance.shift_reconcile",
		"reports.view",
		"customers.view_pii",
		"approvals.decide",
		"audit.view",
		"b2b.view",
		"b2b.write",
		"b2b.approve",
		"b2b.deliver",
		"debt.view",
		"debt.write",
		"invoices.issue"
	]),
	cashier: /* @__PURE__ */ new Set([
		"pos.sell",
		"pos.return",
		"pos.shift",
		"orders.view",
		"prices.view_sell",
		"inventory.view",
		"finance.shift_reconcile"
	]),
	warehouse: /* @__PURE__ */ new Set([
		"inventory.view",
		"inventory.write",
		"prices.view_cost",
		"orders.view",
		"b2b.view",
		"b2b.deliver",
		"debt.view"
	]),
	accountant: /* @__PURE__ */ new Set([
		"orders.view",
		"inventory.view",
		"prices.view_sell",
		"prices.view_cost",
		"finance.view",
		"finance.write",
		"reports.view",
		"customers.view_pii",
		"b2b.view",
		"debt.view",
		"debt.write",
		"invoices.issue"
	]),
	online_staff: /* @__PURE__ */ new Set([
		"orders.view",
		"orders.online.manage",
		"inventory.view",
		"prices.view_sell",
		"customers.view_pii",
		"b2b.view"
	])
};
var can = (role, p) => ROLE_PERMS[role]?.has(p) ?? false;
// src/worker/services/stock.ts
/**
* Tồn khả dụng = tồn thực − đã giữ, chỉ tính lô active, chưa hết hạn, ở vị trí bán được (M1 quy tắc, M2-06).
*/
async function availableQty(db, productId, storeId, at = (/* @__PURE__ */ new Date()).toISOString()) {
	return (await db.prepare(`SELECT COALESCE(SUM(l.qty_on_hand_milli - l.qty_reserved_milli), 0) AS q
         FROM lots l JOIN locations loc ON loc.id = l.location_id
        WHERE l.product_id = ? AND loc.store_id = ? AND loc.sellable = 1 AND l.status = 'active'
          AND (l.expires_at IS NULL OR l.expires_at > ?)`).bind(productId, storeId, at).first())?.q ?? 0;
}
/**
* Phân bổ FEFO (hết hạn trước xuất trước — M2-04). Lô hết hạn không bao giờ được chọn.
* Chỉ ĐỌC; việc trừ kho thực hiện bằng deductStatements() trong một D1 batch.
* Ràng buộc CHECK trên bảng lots là chốt chặn cuối cho bán đồng thời (EC-02):
* nếu tồn đã đổi giữa lúc đọc và ghi, batch vi phạm CHECK và rollback toàn bộ.
*/
async function allocateFefo(db, productId, qtyMilli, storeId, at = (/* @__PURE__ */ new Date()).toISOString()) {
	if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng phải lớn hơn 0");
	const { results } = await db.prepare(`SELECT l.id, l.unit_cost, (l.qty_on_hand_milli - l.qty_reserved_milli) AS available, l.expires_at
         FROM lots l JOIN locations loc ON loc.id = l.location_id
        WHERE l.product_id = ? AND loc.store_id = ? AND loc.sellable = 1 AND l.status = 'active'
          AND (l.expires_at IS NULL OR l.expires_at > ?)
          AND l.qty_on_hand_milli - l.qty_reserved_milli > 0
        ORDER BY (l.expires_at IS NULL), l.expires_at, l.received_at, l.id`).bind(productId, storeId, at).all();
	const out = [];
	let remaining = qtyMilli;
	for (const lot of results) {
		if (remaining <= 0) break;
		const take = Math.min(lot.available, remaining);
		out.push({
			lotId: lot.id,
			qtyMilli: take,
			unitCost: lot.unit_cost
		});
		remaining -= take;
	}
	if (remaining > 0) throw new AppError(409, "insufficient_stock", "Không đủ tồn khả dụng", {
		productId,
		requestedMilli: qtyMilli,
		availableMilli: qtyMilli - remaining
	});
	return out;
}
// src/worker/services/reservations.ts
/** Đọc: phân bổ FEFO cho từng dòng. Ném 409 insufficient_stock nếu thiếu. */
async function planReservations(db, lines, storeId) {
	const byProduct = /* @__PURE__ */ new Map();
	for (const l of lines) byProduct.set(l.productId, [...byProduct.get(l.productId) ?? [], l]);
	const plans = /* @__PURE__ */ new Map();
	for (const [productId, ls] of byProduct) {
		const pool = (await allocateFefo(db, productId, ls.reduce((s, l) => s + l.qtyMilli, 0), storeId)).map((a) => ({ ...a }));
		for (const l of ls) {
			const alloc = [];
			let need = l.qtyMilli;
			for (const a of pool) {
				if (need <= 0) break;
				if (a.qtyMilli <= 0) continue;
				const take = Math.min(a.qtyMilli, need);
				alloc.push({
					lotId: a.lotId,
					unitCost: a.unitCost,
					qtyMilli: take
				});
				a.qtyMilli -= take;
				need -= take;
			}
			plans.set(l.orderLineId, {
				orderLineId: l.orderLineId,
				productId,
				alloc
			});
		}
	}
	return lines.map((l) => plans.get(l.orderLineId));
}
/** Ghi: tăng qty_reserved_milli của lô + dòng reservations. Đưa vào cùng batch với tạo/xác nhận đơn. */
function reserveStmts(db, orderId, plans) {
	const s = [];
	for (const p of plans) for (const a of p.alloc) s.push(db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli + ? WHERE id = ?`).bind(a.qtyMilli, a.lotId), db.prepare(`INSERT INTO reservations(order_id, order_line_id, lot_id, qty_milli) VALUES (?,?,?,?)`).bind(orderId, p.orderLineId, a.lotId, a.qtyMilli));
	return s;
}
async function activeReservations(db, orderId) {
	const { results } = await db.prepare(`SELECT r.id, r.order_line_id, r.lot_id, r.qty_milli, l.product_id, l.unit_cost
         FROM reservations r JOIN lots l ON l.id = r.lot_id
        WHERE r.order_id = ? AND r.status = 'active'
        ORDER BY (l.expires_at IS NULL), l.expires_at, l.id`).bind(orderId).all();
	return results;
}
/** Nhả toàn bộ giữ tồn của đơn (huỷ đơn, EC-06). */
async function releaseOrderStmts(db, orderId) {
	const rows = await activeReservations(db, orderId);
	const now = (/* @__PURE__ */ new Date()).toISOString();
	return rows.flatMap((r) => [db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli - ? WHERE id = ?`).bind(r.qty_milli, r.lot_id), db.prepare(`UPDATE reservations SET status='released', closed_at=? WHERE id=? AND status='active'`).bind(now, r.id)]);
}
// src/worker/services/pricing.ts
/**
* Chọn giá áp dụng tại thời điểm `at` (EC-13): ưu tiên theo price_lists.priority giảm dần
* (mặc định: customer > promo > group > base), cùng ưu tiên thì bản hiệu lực mới nhất.
* Đơn đã chốt lưu unit_price vào order_lines nên không bị ảnh hưởng khi bảng giá đổi (M3 quy tắc).
*/
async function resolvePrice(db, productId, opts) {
	const at = opts.at ?? (/* @__PURE__ */ new Date()).toISOString();
	const row = await db.prepare(`SELECT p.id, p.unit_price, p.price_list_id, pl.kind
         FROM prices p JOIN price_lists pl ON pl.id = p.price_list_id
        WHERE p.product_id = ?1 AND p.status = 'active' AND pl.active = 1
          AND pl.channel IN (?2, 'all')
          AND (pl.customer_group_id IS NULL OR pl.customer_group_id = ?3)
          AND (pl.customer_id IS NULL OR pl.customer_id = ?5)
          AND p.effective_from <= ?4 AND (p.effective_to IS NULL OR p.effective_to > ?4)
        ORDER BY pl.priority DESC, p.effective_from DESC, p.id DESC
        LIMIT 1`).bind(productId, opts.channel, opts.customerGroupId ?? null, at, opts.customerId ?? null).first();
	if (!row) throw new AppError(422, "no_price", "Mặt hàng chưa có giá bán hiệu lực", { productId });
	return {
		unitPrice: row.unit_price,
		priceListId: row.price_list_id,
		priceId: row.id,
		kind: row.kind
	};
}
/** Giá vốn tham chiếu hiện tại (bình quân gia quyền các lô còn tồn) — dùng cảnh báo bán dưới vốn (M3-06). */
async function currentAvgCost(db, productId) {
	return (await db.prepare(`SELECT CASE WHEN SUM(qty_on_hand_milli) > 0
                   THEN CAST(ROUND(1.0 * SUM(unit_cost * qty_on_hand_milli) / SUM(qty_on_hand_milli)) AS INTEGER)
                   ELSE NULL END AS c
         FROM lots WHERE product_id = ? AND status = 'active' AND qty_on_hand_milli > 0`).bind(productId).first())?.c ?? null;
}
// src/worker/services/http.ts
/** Hệ số quy đổi của một đơn vị (đơn vị chính = 1000). */
async function unitFactor(db, productId, unit) {
	const r = await db.prepare(`SELECT pu.factor_milli f FROM product_units pu WHERE pu.product_id = ?1 AND pu.unit = ?2
       UNION ALL SELECT 1000 FROM products WHERE id = ?1 AND base_unit = ?2 LIMIT 1`).bind(productId, unit).first();
	if (!r) throw new AppError(422, "unknown_unit", `Đơn vị "${unit}" không có trong danh mục của mặt hàng`);
	return r.f;
}
// src/worker/services/b2b-orders.ts
var DATE_RE$1 = /^\d{4}-\d{2}-\d{2}$/;
var isCheckFail$2 = (e) => /CHECK constraint failed/i.test(String(e?.message ?? ""));
async function storeIdOf(c) {
	const u = c.get("user");
	if (u.storeId) return u.storeId;
	return (await c.env.DB.prepare(`SELECT id FROM stores WHERE active=1 ORDER BY id LIMIT 1`).first())?.id ?? 1;
}
/** Quy đổi + định giá các dòng đơn sỉ. Có báo giá → giá lấy từ báo giá (dòng ngoài báo giá bị 422). */
async function priceLines(c, customer, lines, quoteLines) {
	const db = c.env.DB;
	const role = c.get("user").role;
	const out = [];
	for (const l of lines) {
		const p = await db.prepare(`SELECT id, active FROM products WHERE id = ?`).bind(l.productId).first();
		if (!p || !p.active) throw new AppError(422, "product_not_found", "Mặt hàng không tồn tại hoặc đã ngừng bán", { productId: l.productId });
		const factor = await unitFactor(db, l.productId, l.unit);
		const qtyMilli = Math.round(l.qty * factor);
		if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng phải lớn hơn 0");
		let unitPrice;
		let priceListId = null;
		if (quoteLines) {
			const ql = quoteLines.find((x) => x.product_id === l.productId);
			if (!ql) throw new AppError(422, "line_not_in_quote", "Mặt hàng không nằm trong báo giá", { productId: l.productId });
			unitPrice = ql.unit_price;
		} else {
			const r = await resolvePrice(db, l.productId, {
				channel: "b2b",
				customerGroupId: customer.customer_group_id,
				customerId: customer.id
			});
			priceListId = r.priceListId;
			unitPrice = l.unitPrice ?? r.unitPrice;
			if (l.unitPrice != null && l.unitPrice !== r.unitPrice && !can(role, "b2b.approve")) throw forbidden("price_override_forbidden", "Đổi giá khác bảng giá cần quyền duyệt");
		}
		out.push({
			productId: l.productId,
			unit: l.unit,
			qtyMilli,
			unitPrice,
			lineTotal: lineAmount(unitPrice, qtyMilli),
			priceListId
		});
	}
	return out;
}
function orderLineInsert(db, orderCode, l) {
	return db.prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, price_list_id, line_total)
       VALUES ((SELECT id FROM orders WHERE code = ?), ?,?,?,?,?,?)`).bind(orderCode, l.productId, l.unit, l.qtyMilli, l.unitPrice, l.priceListId, l.lineTotal);
}
async function loadCustomerForOrder(db, customerId, addressId) {
	const cu = await db.prepare(`SELECT id, type, active, customer_group_id FROM customers WHERE id = ?`).bind(customerId).first();
	if (!cu || cu.type !== "b2b" || !cu.active) throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng sỉ");
	if (!await db.prepare(`SELECT id FROM customer_addresses WHERE id = ? AND customer_id = ? AND active = 1`).bind(addressId, customerId).first()) throw new AppError(422, "address_not_found", "Địa chỉ giao không thuộc khách hàng");
	return cu;
}
/** Tạo đơn sỉ ở trạng thái `new` (chưa giữ tồn). Idempotent theo clientUuid. */
async function createB2bOrder(c, input) {
	const db = c.env.DB;
	const user = c.get("user");
	const existing = await db.prepare(`SELECT id FROM orders WHERE client_uuid = ?`).bind(input.clientUuid).first();
	if (existing) return {
		orderId: existing.id,
		replay: true,
		warnings: []
	};
	if (!DATE_RE$1.test(input.deliveryDate) || input.deliveryDate < vnDate()) throw new AppError(422, "invalid_delivery_date", "Ngày giao không hợp lệ (phải từ hôm nay trở đi, dạng YYYY-MM-DD)");
	const customer = await loadCustomerForOrder(db, input.customerId, input.addressId);
	let quoteLines;
	if (input.quoteId) {
		const q = await db.prepare(`SELECT * FROM quotes WHERE id = ?`).bind(input.quoteId).first();
		if (!q) throw notFound("quote_not_found", "Không tìm thấy báo giá");
		if (q.customer_id !== input.customerId) throw new AppError(422, "quote_customer_mismatch", "Báo giá không thuộc khách hàng này");
		if (q.status === "expired" || ["draft", "sent"].includes(q.status) && q.valid_until < vnDate()) {
			if (q.status === "sent") await db.prepare(`UPDATE quotes SET status='expired' WHERE id = ? AND status='sent'`).bind(q.id).run();
			throw conflict("quote_expired", "Báo giá đã hết hiệu lực", {
				quoteId: q.id,
				validUntil: q.valid_until
			});
		}
		if (!["draft", "sent"].includes(q.status)) throw conflict("quote_not_valid", `Báo giá đang ở trạng thái ${q.status}`, { status: q.status });
		quoteLines = (await db.prepare(`SELECT product_id, unit_price FROM quote_lines WHERE quote_id = ?`).bind(q.id).all()).results;
	}
	if (input.creditOverrideApprovalId) await assertOverrideUsable(db, input.creditOverrideApprovalId, input.customerId);
	const items = await priceLines(c, customer, input.lines, quoteLines);
	const total = items.reduce((s, i) => s + i.lineTotal, 0);
	const warnings = [];
	if (input.quoteId) for (const it of items) {
		const cost = await currentAvgCost(db, it.productId);
		if (cost != null && it.unitPrice < cost) warnings.push({
			productId: it.productId,
			marginBp: Math.round((it.unitPrice - cost) * 1e4 / Math.max(it.unitPrice, 1))
		});
	}
	const code = await nextCode(db, "DS");
	const storeId = await storeIdOf(c);
	const stmts = [db.prepare(`INSERT INTO orders(code, client_uuid, channel, kind, store_id, customer_id, status, subtotal, total, note, created_by,
                            quote_id, address_id, delivery_date, recurring_template_id, credit_override_approval_id)
         VALUES (?,?,'b2b','sale',?,?,'new',?,?,?,?,?,?,?,?,?)`).bind(code, input.clientUuid, storeId, input.customerId, total, total, input.note ?? null, user.id, input.quoteId ?? null, input.addressId, input.deliveryDate, input.recurringTemplateId ?? null, null), ...items.map((i) => orderLineInsert(db, code, i))];
	if (input.quoteId) stmts.push(db.prepare(`UPDATE quotes SET status='accepted' WHERE id = ? AND status IN ('draft','sent')`).bind(input.quoteId));
	stmts.push(auditStmt(c, {
		action: "b2b_order.create",
		entity: "b2b_order",
		entityId: code,
		after: {
			customerId: input.customerId,
			total,
			lines: items.length,
			quoteId: input.quoteId ?? null
		}
	}));
	try {
		await db.batch(stmts);
	} catch (e) {
		const again = await db.prepare(`SELECT id FROM orders WHERE client_uuid = ?`).bind(input.clientUuid).first();
		if (again) return {
			orderId: again.id,
			replay: true,
			warnings
		};
		throw e;
	}
	return {
		orderId: (await db.prepare(`SELECT id FROM orders WHERE code = ?`).bind(code).first()).id,
		replay: false,
		warnings
	};
}
/** Approval credit_override dùng được: đã duyệt, đúng khách. */
async function assertOverrideUsable(db, approvalId, customerId) {
	const a = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(approvalId).first();
	let payload = {};
	try {
		payload = JSON.parse(a?.payload_json ?? "{}");
	} catch {}
	if (!a || a.type !== "order.credit_override" || a.status !== "approved" || payload.customerId !== customerId) throw conflict("approval_invalid", "Mã duyệt vượt hạn mức không hợp lệ", { approvalId });
}
async function findOverride(db, order, explicitId) {
	const a = explicitId ? await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(explicitId).first() : await db.prepare(`SELECT * FROM approvals WHERE type='order.credit_override' AND ref_type='order' AND ref_id = ? AND status='approved' ORDER BY id DESC LIMIT 1`).bind(String(order.id)).first();
	if (!a) {
		if (explicitId) throw conflict("approval_invalid", "Mã duyệt vượt hạn mức không hợp lệ", { approvalId: explicitId });
		return null;
	}
	let payload = {};
	try {
		payload = JSON.parse(a.payload_json ?? "{}");
	} catch {}
	if (!(a.type === "order.credit_override" && a.status === "approved" && payload.customerId === order.customer_id && (a.ref_id == null || a.ref_id === String(order.id)) && (payload.total ?? 0) >= order.total)) {
		if (explicitId) throw conflict("approval_invalid", "Mã duyệt vượt hạn mức không hợp lệ hoặc không đủ cho giá trị đơn", { approvalId: explicitId });
		return null;
	}
	return a.id;
}
/**
* EC-23: kiểm hạn mức TRƯỚC khi giữ tồn. Không đạt (và chưa có duyệt của chủ) → tạo approval + 409 credit_blocked.
* Đạt → giữ tồn FEFO + status confirmed trong một batch. Thiếu tồn → 409 insufficient_stock (đơn vẫn new).
*/
async function confirmOrderFlow(c, orderId, overrideApprovalId) {
	const db = c.env.DB;
	const user = c.get("user");
	const o = await db.prepare(`SELECT * FROM orders WHERE id = ? AND channel = 'b2b'`).bind(orderId).first();
	if (!o) throw notFound("order_not_found", "Không tìm thấy đơn sỉ");
	if (o.status !== "new" && o.status !== "delivery_failed") throw conflict("invalid_status", `Đơn đang ở trạng thái ${o.status}`, { status: o.status });
	const chk = await checkCredit(db, o.customer_id, o.total);
	let override = null;
	if (!chk.ok) {
		override = await findOverride(db, o, overrideApprovalId);
		if (!override) {
			let approvalId = (await db.prepare(`SELECT id FROM approvals WHERE type='order.credit_override' AND ref_type='order' AND ref_id = ? AND status='pending' LIMIT 1`).bind(String(orderId)).first())?.id;
			if (!approvalId) approvalId = (await db.batch([db.prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('order.credit_override','order',?,?,?,?)`).bind(String(orderId), JSON.stringify({
				customerId: o.customer_id,
				total: o.total,
				reasons: chk.reasons,
				orderCode: o.code
			}), chk.reasons.join(","), user.id), auditStmt(c, {
				action: "approval.request",
				entity: "b2b_order",
				entityId: o.code,
				after: {
					type: "order.credit_override",
					reasons: chk.reasons
				}
			})]))[0].meta.last_row_id;
			throw conflict("credit_blocked", "Khách vượt hạn mức hoặc có nợ quá hạn, cần chủ cửa hàng duyệt", {
				approvalId,
				reasons: chk.reasons,
				status: chk.status,
				orderId,
				orderAmount: o.total
			});
		}
	}
	const lines = (await db.prepare(`SELECT id, product_id, qty_milli FROM order_lines WHERE order_id = ? ORDER BY id`).bind(orderId).all()).results;
	const plans = await planReservations(db, lines.map((l) => ({
		orderLineId: l.id,
		productId: l.product_id,
		qtyMilli: l.qty_milli
	})), o.store_id);
	try {
		await db.batch([
			...reserveStmts(db, orderId, plans),
			db.prepare(`UPDATE orders SET status='confirmed', credit_override_approval_id = COALESCE(?, credit_override_approval_id) WHERE id = ? AND status IN ('new','delivery_failed')`).bind(override, orderId),
			auditStmt(c, {
				action: "b2b_order.confirm",
				entity: "b2b_order",
				entityId: o.code,
				before: { status: o.status },
				after: {
					status: "confirmed",
					creditOverrideApprovalId: override
				}
			})
		]);
	} catch (e) {
		if (isCheckFail$2(e)) throw conflict("insufficient_stock", "Không đủ tồn khả dụng (tồn vừa thay đổi), vui lòng thử lại");
		throw e;
	}
}
var stepOf = (baseUnit, onlineStep) => onlineStep ?? (baseUnit === "kg" ? 500 : 1e3);
/** Tồn hiển thị: chặn trên 99 đơn vị, làm tròn xuống theo bước đặt hàng. */
function publicAvail(realMilli, stepMilli) {
	return Math.floor(Math.min(Math.max(realMilli, 0), 99e3) / stepMilli) * stepMilli;
}
/** Biểu thức SQL chọn giá hiệu lực (cùng quy tắc ưu tiên với services/pricing.resolvePrice). ?1=now ?2=group ?3=customer */
var PRICE_SQL = (chan) => `(SELECT p2.unit_price FROM prices p2 JOIN price_lists pl ON pl.id = p2.price_list_id
   WHERE p2.product_id = p.id AND p2.status = 'active' AND pl.active = 1 AND pl.channel IN ('${chan}', 'all')
     AND (pl.customer_group_id IS NULL OR pl.customer_group_id = ?2)
     AND (pl.customer_id IS NULL OR pl.customer_id = ?3)
     AND p2.effective_from <= ?1 AND (p2.effective_to IS NULL OR p2.effective_to > ?1)
   ORDER BY pl.priority DESC, p2.effective_from DESC, p2.id DESC LIMIT 1)`;
var AVAIL_SQL = `(SELECT COALESCE(SUM(l.qty_on_hand_milli - l.qty_reserved_milli), 0) FROM lots l JOIN locations loc ON loc.id = l.location_id
   WHERE l.product_id = p.id AND loc.store_id = ?4 AND loc.sellable = 1 AND l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at > ?1))`;
async function queryCards(db, o) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const store = await onlineStoreId(db);
	const binds = [
		now,
		o.groupId ?? null,
		o.customerId ?? null,
		store,
		...o.binds ?? []
	];
	const published = o.onlyPublished === false ? "" : "AND p.published_online = 1 AND p.slug IS NOT NULL";
	const sql = `SELECT * FROM (
      SELECT p.id, p.slug, p.name, p.origin, p.base_unit, p.sell_by_weight, p.allow_preorder, p.online_step_milli, p.images_json,
             p.description, p.group_id, p.featured, p.online_sort, g.name AS group_name,
             ${PRICE_SQL(o.channel)} AS price, ${AVAIL_SQL} AS avail
        FROM products p LEFT JOIN product_groups g ON g.id = p.group_id
       WHERE p.active = 1 AND p.merged_into IS NULL ${published}
    ) p WHERE p.price IS NOT NULL ${o.where?.length ? "AND " + o.where.join(" AND ") : ""}
    ORDER BY ${o.order ?? "p.featured DESC, p.online_sort ASC, p.id ASC"}
    ${o.limit ? `LIMIT ${Math.floor(o.limit)} OFFSET ${Math.floor(o.offset ?? 0)}` : ""}`;
	const { results } = await db.prepare(sql).bind(...binds).all();
	const ids = results.map((r) => r.id);
	const units = /* @__PURE__ */ new Map();
	if (ids.length) {
		const u = await db.prepare(`SELECT product_id, unit, factor_milli FROM product_units WHERE product_id IN (${ids.map(() => "?").join(",")}) ORDER BY factor_milli`).bind(...ids).all();
		for (const x of u.results) units.set(x.product_id, [...units.get(x.product_id) ?? [], {
			unit: x.unit,
			factorMilli: x.factor_milli
		}]);
	}
	return results.map((r) => ({
		row: r,
		card: {
			id: r.id,
			slug: r.slug ?? String(r.id),
			name: r.name,
			origin: r.origin,
			baseUnit: r.base_unit,
			unitLabel: unitLabel(r.base_unit),
			price: r.price,
			imageUrl: imageUrl(parseImages(r.images_json)[0]),
			inStock: publicAvail(r.avail, stepOf(r.base_unit, r.online_step_milli)) >= stepOf(r.base_unit, r.online_step_milli),
			availableMilli: publicAvail(r.avail, stepOf(r.base_unit, r.online_step_milli)),
			allowPreorder: !!r.allow_preorder,
			stepMilli: stepOf(r.base_unit, r.online_step_milli),
			sellByWeight: !!r.sell_by_weight,
			units: [{
				unit: r.base_unit,
				factorMilli: 1e3
			}, ...(units.get(r.id) ?? []).filter((x) => x.unit !== r.base_unit)]
		}
	}));
}
var cards = async (db, o) => (await queryCards(db, o)).map((x) => x.card);
// src/worker/services/online-orders.ts
var ONLINE_TRANSITIONS = {
	awaiting_payment: ["new", "cancelled"],
	new: ["confirmed", "cancelled"],
	confirmed: ["preparing", "cancelled"],
	preparing: ["shipping", "cancelled"],
	shipping: ["completed", "delivery_failed"],
	delivery_failed: ["confirmed", "returned"],
	completed: ["returned"],
	cancelled: [],
	returned: []
};
var CUSTOMER_LABEL = {
	awaiting_payment: "Chờ thanh toán",
	new: "Chờ xác nhận",
	confirmed: "Đã xác nhận",
	preparing: "Đang chuẩn bị",
	shipping: "Đang giao",
	completed: "Hoàn tất",
	cancelled: "Đã huỷ",
	delivery_failed: "Giao không thành công",
	returned: "Đã trả hàng"
};
function assertTransition(from, to) {
	const allowed = ONLINE_TRANSITIONS[from];
	if (!allowed || !allowed.includes(to)) throw new AppError(409, "invalid_transition", `Không thể chuyển đơn từ "${CUSTOMER_LABEL[from] ?? from}" sang "${CUSTOMER_LABEL[to]}"`, {
		from,
		to
	});
}
/**
* Statements đổi trạng thái + ghi order_events, có điều kiện `status = from` để chống hai người đổi cùng lúc:
* nếu trạng thái đã bị đổi, UPDATE không khớp dòng nào và INSERT sự kiện dùng SELECT ... WHERE changes() — xem guard bên dưới.
* Gộp vào cùng batch với các tác động khác (giữ/nhả tồn, thanh toán, audit).
*/
function transitionStmts(db, orderId, from, to, actor, opts = {}) {
	assertTransition(from, to);
	const completed = to === "completed" ? `, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')` : "";
	return [
		db.prepare(`INSERT INTO order_transition_guard(order_id, ok) SELECT ?1, CASE WHEN status = ?2 THEN 1 ELSE 0 END FROM orders WHERE id = ?1`).bind(orderId, from),
		db.prepare(`UPDATE orders SET status = ?1${completed}${opts.extraSet ? ", " + opts.extraSet : ""} WHERE id = ?2`).bind(to, orderId, ...opts.extraBinds ?? []),
		db.prepare(`INSERT INTO order_events(order_id, status, note, internal_note, actor_type, actor_id) VALUES (?,?,?,?,?,?)`).bind(orderId, to, opts.note ?? null, opts.internalNote ?? null, actor.type, actor.id ?? null),
		db.prepare(`DELETE FROM order_transition_guard WHERE order_id = ?`).bind(orderId)
	];
}
/** Sinh tracking token ngẫu nhiên (base64url, 24 byte) cho link tra cứu đơn của khách. */
function newTrackingToken() {
	const b = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(24));
	return btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
/** Bỏ dấu tiếng Việt + thường hoá để so khớp quận/huyện với delivery_zones. */
function normalizeVi(s) {
	return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replaceAll("đ", "d").replaceAll("Đ", "D").toLowerCase().replace(/\s+/g, " ").trim();
}
// src/shop/worker/lib/vietqr.ts
/**
* Chuỗi VietQR (EMVCo MPM, tiêu chuẩn NAPAS) cho chuyển nhanh 24/7 tới tài khoản ngân hàng.
* 00 Payload Format "01" · 01 Point of Initiation "12" (động, có số tiền) · 38 Merchant Account Info
*   (00 GUID A000000727 · 01 [00 BIN · 01 số TK] · 02 dịch vụ QRIBFTTA) · 53 tiền tệ 704 · 54 số tiền ·
*  58 quốc gia VN · 62 Additional Data (08 = nội dung chuyển khoản) · 63 CRC16-CCITT(FALSE) của toàn bộ chuỗi tới "6304".
*/
var tlv = (tag, value) => `${tag}${String(value.length).padStart(2, "0")}${value}`;
function crc16ccitt(s) {
	let crc = 65535;
	for (let i = 0; i < s.length; i++) {
		crc ^= s.charCodeAt(i) << 8;
		for (let b = 0; b < 8; b++) crc = crc & 32768 ? (crc << 1 ^ 4129) & 65535 : crc << 1 & 65535;
	}
	return crc.toString(16).toUpperCase().padStart(4, "0");
}
function buildVietQr(i) {
	const content = i.content.replace(/[^\x20-\x7E]/g, "").slice(0, 25);
	const acct = tlv("00", i.bankBin) + tlv("01", i.accountNo);
	const mai = tlv("00", "A000000727") + tlv("01", acct) + tlv("02", "QRIBFTTA");
	let p = tlv("00", "01") + tlv("01", "12") + tlv("38", mai) + tlv("53", "704");
	if (i.amount > 0) p += tlv("54", String(Math.round(i.amount)));
	p += tlv("58", "VN") + tlv("62", tlv("08", content));
	p += "6304";
	return p + crc16ccitt(p);
}
// src/shop/worker/lib/orderview.ts
var CANCELLABLE = [
	"awaiting_payment",
	"new",
	"confirmed"
];
var label = (s) => CUSTOMER_LABEL[s] ?? s;
/** Thông tin chuyển khoản của đơn: dựa trên payment_intent vietqr đang chờ. null nếu không áp dụng. */
async function transferInfoFor(db, order) {
	if (order.status !== "awaiting_payment" || order.payment_status === "paid") return null;
	const it = await db.prepare(`SELECT amount, transfer_content, expires_at FROM payment_intents WHERE order_id = ? AND provider = 'vietqr' AND status = 'pending' ORDER BY id DESC LIMIT 1`).bind(order.id).first();
	if (!it) return null;
	const bankBin = await setting(db, "payment.bank_bin", "970436");
	const accountNo = await setting(db, "payment.bank_account", "");
	return {
		bankBin,
		accountNo,
		accountName: await setting(db, "payment.bank_account_name", ""),
		amount: it.amount,
		content: it.transfer_content,
		qrPayload: buildVietQr({
			bankBin,
			accountNo,
			amount: it.amount,
			content: it.transfer_content
		}),
		expiresAt: it.expires_at
	};
}
/** Nạp OrderView (không trả internal_note, giá vốn, lô). */
async function orderView(db, o) {
	const [lines, events, slot, b2bAddr] = await Promise.all([
		db.prepare(`SELECT ol.*, p.name AS product_name, p.images_json,
                COALESCE((SELECT pu.factor_milli FROM product_units pu WHERE pu.product_id = ol.product_id AND pu.unit = ol.unit), 1000) AS factor
           FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`).bind(o.id).all(),
		db.prepare(`SELECT at, status, note FROM order_events WHERE order_id = ? ORDER BY at, id`).bind(o.id).all(),
		o.slot_id ? db.prepare(`SELECT label FROM delivery_slots WHERE id = ?`).bind(o.slot_id).first() : null,
		o.channel === "b2b" && o.address_id ? db.prepare(`SELECT address FROM customer_addresses WHERE id = ?`).bind(o.address_id).first() : null
	]);
	const transfer = await transferInfoFor(db, o);
	const hasWeightLine = !!await db.prepare(`SELECT 1 AS x FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? AND p.sell_by_weight = 1 LIMIT 1`).bind(o.id).first();
	const view = {
		code: o.code,
		trackingToken: o.tracking_token ?? null,
		status: o.status,
		statusLabel: label(o.status),
		createdAt: o.created_at,
		slotDate: o.slot_date ?? o.delivery_date ?? null,
		slotLabel: slot?.label ?? null,
		receiverName: o.receiver_name ?? null,
		receiverPhoneMasked: maskPhone(o.receiver_phone),
		shipAddress: o.ship_address ?? b2bAddr?.address ?? null,
		paymentMethod: o.payment_method ?? (o.channel === "b2b" ? "credit" : null),
		paymentStatus: o.payment_status,
		estimated: hasWeightLine && !["completed", "returned"].includes(o.status) && o.weight_adjust_status === "none",
		estimatedTotal: o.estimated_total ?? o.total,
		subtotal: o.subtotal,
		shippingFee: o.shipping_fee,
		discount: o.discount,
		total: o.total,
		weightAdjustStatus: o.weight_adjust_status,
		lines: lines.results.map((l) => ({
			productId: l.product_id,
			name: l.product_name,
			imageUrl: imageUrl(parseImages(l.images_json)[0]),
			unit: l.unit,
			orderedQty: (l.ordered_qty_milli ?? l.qty_milli) / l.factor,
			qty: l.qty_milli / l.factor,
			unitPrice: l.unit_price,
			lineTotal: l.line_total,
			preorderMilli: l.preorder_milli ?? 0
		})),
		events: events.results.map((e) => ({
			at: e.at,
			status: e.status,
			statusLabel: label(e.status),
			note: e.note
		})),
		canCancel: o.channel === "online" && CANCELLABLE.includes(o.status)
	};
	if (transfer) view.transfer = transfer;
	return view;
}
var ORDER_COLS = `o.*`;
/** Đơn thuộc về khách đang đăng nhập (đơn online của tài khoản; khách sỉ đã duyệt còn thấy đơn sỉ của hồ sơ khách). */
function ownedWhere(a) {
	return {
		sql: `(o.channel = 'online' AND o.shop_account_id = ?1) OR (o.channel = 'b2b' AND ?3 = 'approved' AND o.customer_id = ?2)`,
		binds: [
			a.id,
			a.customerId,
			a.kind === "b2b" ? a.b2bStatus ?? "" : ""
		]
	};
}
async function findOwnedOrder(db, a, code) {
	const w = ownedWhere(a);
	return db.prepare(`SELECT ${ORDER_COLS} FROM orders o WHERE o.code = ?4 AND (${w.sql})`).bind(...w.binds, code).first();
}
/** Tra cứu khách vãng lai: token + 4 số cuối SĐT người nhận. Sai bất kỳ → null (404). */
async function findByTracking(db, token, phone4) {
	if (!token || token.length > 128 || !phone4 || !/^\d{4}$/.test(phone4)) return null;
	const o = await db.prepare(`SELECT ${ORDER_COLS} FROM orders o WHERE o.tracking_token = ? AND o.channel = 'online'`).bind(token).first();
	if (!o || last4(o.receiver_phone) !== phone4) return null;
	return o;
}
// src/shop/worker/lib/delivery.ts
/** Tìm khu vực giao theo quận/huyện (so khớp không dấu, không phân biệt hoa thường). */
async function findZone(db, district) {
	if (!district?.trim()) return null;
	const want = normalizeVi(district);
	const { results } = await db.prepare(`SELECT id, name, districts_json, fee, free_over, min_order FROM delivery_zones WHERE active = 1 ORDER BY id`).all();
	for (const z of results) {
		let list;
		try {
			list = JSON.parse(z.districts_json);
		} catch {
			continue;
		}
		if (Array.isArray(list) && list.some((d) => typeof d === "string" && normalizeVi(d) === want)) return {
			id: z.id,
			name: z.name,
			fee: z.fee,
			freeOver: z.free_over,
			minOrder: z.min_order
		};
	}
	return null;
}
var shippingFee = (z, subtotal) => z.freeOver != null && subtotal >= z.freeOver ? 0 : z.fee;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Thứ trong tuần 1..7 (Thứ Hai = 1) của ngày YYYY-MM-DD. */
var isoWeekday = (day) => ((/* @__PURE__ */ new Date(day + "T00:00:00Z")).getUTCDay() + 6) % 7 + 1;
var addDaysStr = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
/** Kiểm tra một khung giờ của một ngày: trả lý do không đặt được hoặc null nếu còn đặt được. */
async function slotProblem(db, slot, date, now = /* @__PURE__ */ new Date()) {
	if (!slot.weekdays.split(",").map((x) => x.trim()).includes(String(isoWeekday(date)))) return "closed";
	if (date < vnDate(now)) return "past";
	const start = Date.parse(`${date}T${slot.start_time}:00+07:00`);
	if (now.getTime() > start - slot.cutoff_minutes * 6e4) return "cutoff";
	if (((await db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE slot_date = ? AND slot_id = ? AND status <> 'cancelled'`).bind(date, slot.id).first())?.n ?? 0) >= slot.capacity) return "full";
	return null;
}
async function activeSlots(db) {
	return (await db.prepare(`SELECT id, label, start_time, end_time, cutoff_minutes, capacity, weekdays FROM delivery_slots WHERE active = 1 ORDER BY start_time, id`).all()).results;
}
async function getSlot(db, id) {
	return db.prepare(`SELECT id, label, start_time, end_time, cutoff_minutes, capacity, weekdays FROM delivery_slots WHERE id = ? AND active = 1`).bind(id).first();
}
var MAX_LINE_MILLI = 1e6;
/** Định giá server-side. Mặt hàng chưa công bố / chưa có giá online → issue 'unpublished' và bị loại khỏi dòng. */
async function priceCart(db, items) {
	if (items.length === 0) throw new AppError(422, "empty_cart", "Giỏ hàng trống");
	if (items.length > 50) throw new AppError(422, "too_many_lines", `Tối đa 50 mặt hàng`);
	const issues = [];
	const lines = [];
	for (const [index, it] of items.entries()) {
		const p = await db.prepare(`SELECT id, name, base_unit, sell_by_weight, allow_preorder, online_step_milli, images_json, published_online, slug
           FROM products WHERE id = ? AND active = 1 AND merged_into IS NULL`).bind(it.productId).first();
		let price = null;
		if (p?.published_online && p.slug) try {
			price = (await resolvePrice(db, p.id, { channel: "online" })).unitPrice;
		} catch (e) {
			if (!(e instanceof AppError && e.code === "no_price")) throw e;
		}
		if (!p || price == null) {
			issues.push({
				productId: it.productId,
				code: "unpublished",
				message: "Sản phẩm hiện không còn bán online"
			});
			continue;
		}
		const factor = await unitFactor(db, p.id, it.unit);
		const qtyMilli = Math.round(it.qty * factor);
		const step = stepOf(p.base_unit, p.online_step_milli);
		if (!(qtyMilli > 0) || qtyMilli > MAX_LINE_MILLI) throw new AppError(422, "invalid_qty", "Số lượng không hợp lệ", { productId: p.id });
		if (qtyMilli % step !== 0) throw new AppError(422, "invalid_qty_step", `Số lượng phải là bội của bước đặt hàng`, {
			productId: p.id,
			stepMilli: step
		});
		let imageKey = null;
		try {
			const imgs = JSON.parse(p.images_json ?? "[]");
			imageKey = Array.isArray(imgs) && typeof imgs[0] === "string" ? imgs[0] : null;
		} catch {}
		lines.push({
			index,
			productId: p.id,
			name: p.name,
			imageKey,
			unit: it.unit,
			qty: it.qty,
			qtyMilli,
			factorMilli: factor,
			unitPrice: price,
			lineTotal: lineAmount(price, qtyMilli),
			sellByWeight: !!p.sell_by_weight,
			allowPreorder: !!p.allow_preorder,
			stepMilli: step,
			expectedUnitPrice: it.expectedUnitPrice,
			coveredMilli: qtyMilli,
			preorderMilli: 0
		});
	}
	return {
		lines,
		issues
	};
}
/**
* Chia từng dòng thành phần có hàng (coveredMilli) và phần thiếu. Cùng sản phẩm nhiều dòng dùng chung một quỹ tồn.
* Thiếu: nếu sản phẩm cho đặt trước → preorderMilli = phần thiếu; ngược lại giữ preorderMilli = 0 và đánh dấu short.
* Trả `realAvail` theo sản phẩm để dùng trong thông báo lỗi (chỉ phát ra dạng đã che).
*/
async function applyStock(db, storeId, lines) {
	const remaining = /* @__PURE__ */ new Map();
	const short = [];
	for (const l of lines) {
		if (!remaining.has(l.productId)) remaining.set(l.productId, await availableQty(db, l.productId, storeId));
		const have = remaining.get(l.productId);
		const covered = Math.min(have, l.qtyMilli);
		remaining.set(l.productId, have - covered);
		l.coveredMilli = covered;
		const miss = l.qtyMilli - covered;
		l.preorderMilli = l.allowPreorder ? miss : 0;
		if (miss > 0) short.push({
			line: l,
			shortMilli: miss,
			remainingBefore: have
		});
	}
	return short;
}
var publicRemaining = (l, remainingBefore) => publicAvail(remainingBefore, l.stepMilli);
async function computeTotals(db, lines, district) {
	const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
	const zone = await findZone(db, district);
	const fee = zone ? shippingFee(zone, subtotal) : 0;
	return {
		subtotal,
		shippingFee: fee,
		total: subtotal + fee,
		zone,
		estimated: lines.some((l) => l.sellByWeight)
	};
}
// src/shop/worker/routes/cart.ts
var cartRoutes = new Hono();
var ItemSchema = objectType({
	productId: numberType().int().positive(),
	unit: stringType().min(1).max(20),
	qty: numberType().positive().max(1e5)
});
var QuoteSchema = objectType({
	items: arrayType(ItemSchema).min(1).max(50),
	addressId: numberType().int().positive().optional(),
	district: stringType().max(100).optional(),
	slotDate: stringType().regex(DATE_RE).optional(),
	slotId: numberType().int().positive().optional()
});
var SLOT_MSG = {
	closed: "Khung giờ không giao vào ngày này",
	past: "Ngày giao đã qua",
	cutoff: "Đã quá giờ chốt đặt cho khung giờ này",
	full: "Khung giờ đã đầy"
};
cartRoutes.post("/cart/quote", optionalAuth, async (c) => {
	const db = c.env.DB;
	const b = await parseBody(c, QuoteSchema);
	let district = b.district ?? null;
	if (b.addressId) {
		const a = c.get("account");
		if (!a) throw new AppError(401, "unauthenticated", "Vui lòng đăng nhập để dùng sổ địa chỉ");
		const ad = await db.prepare(`SELECT district FROM shop_addresses WHERE id = ? AND account_id = ? AND active = 1`).bind(b.addressId, a.id).first();
		if (!ad) throw new AppError(404, "address_not_found", "Không tìm thấy địa chỉ");
		district = ad.district;
	}
	const { lines, issues } = await priceCart(db, b.items);
	const short = await applyStock(db, await onlineStoreId(db), lines);
	for (const s of short) issues.push({
		productId: s.line.productId,
		code: s.remainingBefore <= 0 ? "out_of_stock" : "insufficient",
		message: s.line.allowPreorder ? "Không đủ hàng, phần thiếu sẽ giao khi hàng về (đặt trước)" : s.remainingBefore <= 0 ? "Sản phẩm tạm hết hàng" : "Không đủ số lượng yêu cầu"
	});
	const t = await computeTotals(db, lines, district);
	if (district && !t.zone) issues.push({
		productId: null,
		code: "zone_unsupported",
		message: "Chưa hỗ trợ giao hàng tới khu vực này"
	});
	if (t.zone && t.subtotal < t.zone.minOrder) issues.push({
		productId: null,
		code: "min_order",
		message: `Đơn tối thiểu ${t.zone.minOrder.toLocaleString("vi-VN")}đ cho khu vực này`
	});
	if (b.slotDate && b.slotId) {
		const slot = await getSlot(db, b.slotId);
		const why = slot ? await slotProblem(db, slot, b.slotDate) : "closed";
		if (why) issues.push({
			productId: null,
			code: "slot_unavailable",
			message: SLOT_MSG[why] ?? "Khung giờ không khả dụng"
		});
	}
	return c.json({
		lines: lines.map((l) => ({
			productId: l.productId,
			name: l.name,
			unit: l.unit,
			qty: l.qty,
			qtyMilli: l.qtyMilli,
			unitPrice: l.unitPrice,
			lineTotal: l.lineTotal,
			available: l.coveredMilli >= l.qtyMilli,
			preorderMilli: l.preorderMilli,
			sellByWeight: l.sellByWeight
		})),
		subtotal: t.subtotal,
		shippingFee: t.shippingFee,
		zone: t.zone ? {
			id: t.zone.id,
			name: t.zone.name
		} : null,
		total: t.total,
		estimated: t.estimated,
		issues
	});
});
/** Khu vực giao đang hoạt động + danh sách quận/huyện (cho ô chọn địa chỉ). Server vẫn là nơi quyết định khi quote/checkout. */
cartRoutes.get("/delivery/zones", async (c) => {
	const { results } = await c.env.DB.prepare(`SELECT id, name, districts_json, fee, free_over, min_order FROM delivery_zones WHERE active = 1 ORDER BY fee, id`).all();
	const zones = results.map((z) => {
		let districts = [];
		try {
			districts = JSON.parse(z.districts_json).filter((d) => typeof d === "string");
		} catch {}
		return {
			id: z.id,
			name: z.name,
			fee: z.fee,
			freeOver: z.free_over,
			minOrder: z.min_order,
			districts
		};
	});
	c.header("Cache-Control", "public, max-age=300");
	return c.json({ zones });
});
cartRoutes.get("/delivery/slots", async (c) => {
	const db = c.env.DB;
	const date = c.req.query("date");
	if (date && !DATE_RE.test(date)) throw new AppError(422, "invalid_date", "Ngày không hợp lệ (YYYY-MM-DD)");
	const zone = await findZone(db, c.req.query("district"));
	const days = date ? [date] : Array.from({ length: 7 }, (_, i) => addDaysStr(vnDate(), i));
	const slots = await activeSlots(db);
	const out = [];
	for (const d of days) for (const s of slots) {
		const why = await slotProblem(db, s, d);
		if (why === "closed") continue;
		out.push({
			date: d,
			id: s.id,
			label: s.label,
			startTime: s.start_time,
			endTime: s.end_time,
			available: !why,
			...why ? { reason: why } : {}
		});
	}
	return c.json({
		zone: zone ? {
			id: zone.id,
			name: zone.name,
			fee: zone.fee,
			freeOver: zone.freeOver,
			minOrder: zone.minOrder
		} : null,
		slots: out
	});
});
// src/shop/worker/routes/b2b.ts
var b2bRoutes = new Hono();
b2bRoutes.post("/b2b/link-request", requireAccount, async (c) => {
	const a = c.get("account");
	const db = c.env.DB;
	const b = await parseBody(c, objectType({
		companyName: stringType().trim().min(1).max(200),
		taxCode: stringType().trim().min(8).max(20).regex(/^[0-9-]+$/),
		note: stringType().trim().max(500).optional()
	}));
	if (a.b2bStatus === "approved") throw conflict("already_approved", "Tài khoản đã được liên kết khách sỉ");
	if (a.b2bStatus === "pending") throw conflict("already_pending", "Yêu cầu liên kết đang chờ duyệt");
	await db.batch([db.prepare(`UPDATE shop_accounts SET b2b_status = 'pending' WHERE id = ?`).bind(a.id), db.prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('shop.b2b_link','shop_account',?,?,?,1)`).bind(String(a.id), JSON.stringify({
		accountId: a.id,
		companyName: b.companyName,
		taxCode: b.taxCode,
		note: b.note ?? null
	}), `Yêu cầu liên kết khách sỉ: ${b.companyName}`)]);
	return c.json({
		ok: true,
		b2bStatus: "pending"
	}, 201);
});
b2bRoutes.use("/b2b/catalog", requireAccount, requireB2b);
b2bRoutes.use("/b2b/orders", requireAccount, requireB2b);
b2bRoutes.use("/b2b/addresses", requireAccount, requireB2b);
b2bRoutes.get("/b2b/catalog", async (c) => {
	const a = c.get("account");
	const db = c.env.DB;
	const offset = /^\d+$/.test(c.req.query("cursor") ?? "") ? Number(c.req.query("cursor")) : 0;
	const q = c.req.query("q")?.trim();
	const where = [];
	const binds = [];
	if (q) binds.push(`%${q.replace(/[\\%_]/g, (m) => "\\" + m).slice(0, 60)}%`), where.push(`p.name LIKE ?5 ESCAPE '\\'`);
	const rows = await cards(db, {
		channel: "b2b",
		groupId: a.customerGroupId,
		customerId: a.customerId,
		onlyPublished: false,
		where,
		binds,
		order: "p.name ASC",
		limit: 101,
		offset
	});
	const st = await customerDebtStatus(db, a.customerId);
	return c.json({
		items: rows.slice(0, 100),
		nextCursor: rows.length > 100 ? String(offset + 100) : null,
		creditStatus: {
			creditLimit: st.creditLimit,
			balance: st.balance,
			available: st.available,
			overdueAmount: st.overdueAmount,
			overdue: st.overdueCount > 0
		}
	});
});
b2bRoutes.get("/b2b/addresses", async (c) => {
	const { results } = await c.env.DB.prepare(`SELECT id, label, address, is_default FROM customer_addresses WHERE customer_id = ? AND active = 1 ORDER BY is_default DESC, id`).bind(c.get("account").customerId).all();
	return c.json({ items: results.map((r) => ({
		id: r.id,
		label: r.label,
		address: r.address,
		isDefault: !!r.is_default
	})) });
});
/** Ngữ cảnh "người dùng hệ thống" để tái dùng dịch vụ đơn sỉ của ERP. Vai trò manager: KHÔNG có b2b.credit_override. */
var SHOP_SYSTEM_USER = {
	id: 1,
	username: "system",
	fullName: "Shop (hệ thống)",
	role: "manager",
	storeId: null,
	sessionId: "shop-system",
	deviceId: null
};
function systemCtx(c) {
	const vars = {
		user: SHOP_SYSTEM_USER,
		requestId: c.get("requestId")
	};
	return {
		env: c.env,
		get: (k) => vars[k],
		req: { header: (n) => c.req.header(n) }
	};
}
b2bRoutes.post("/b2b/orders", async (c) => {
	const a = c.get("account");
	const db = c.env.DB;
	const b = await parseBody(c, objectType({
		clientUuid: stringType().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
		addressId: numberType().int().positive(),
		deliveryDate: stringType().regex(DATE_RE$1),
		note: stringType().trim().max(500).optional(),
		lines: arrayType(ItemSchema).min(1).max(100)
	}));
	const ctx = systemCtx(c);
	const res = await createB2bOrder(ctx, {
		customerId: a.customerId,
		addressId: b.addressId,
		deliveryDate: b.deliveryDate,
		note: b.note,
		clientUuid: b.clientUuid,
		lines: b.lines.map((l) => ({
			productId: l.productId,
			unit: l.unit,
			qty: l.qty
		}))
	});
	const owner = await db.prepare(`SELECT customer_id, channel FROM orders WHERE id = ?`).bind(res.orderId).first();
	if (!owner || owner.channel !== "b2b" || owner.customer_id !== a.customerId) throw conflict("duplicate_client_uuid", "Mã yêu cầu đã được dùng");
	if ((await db.prepare(`SELECT status FROM orders WHERE id = ?`).bind(res.orderId).first())?.status === "new") await confirmOrderFlow(ctx, res.orderId);
	if (!res.replay) await db.batch([sysAuditStmt(db, {
		action: "shop.b2b_order",
		entity: "order",
		entityId: res.orderId,
		after: {
			accountId: a.id,
			customerId: a.customerId
		}
	})]);
	const o = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(res.orderId).first();
	return c.json(await orderView(db, o), res.replay ? 200 : 201);
});
// src/shop/worker/routes/catalog.ts
var catalogRoutes = new Hono();
var PAGE = 24;
catalogRoutes.get("/home", async (c) => {
	const db = c.env.DB;
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const [banners, featured, all, posts] = await Promise.all([
		db.prepare(`SELECT id, title, image_key, link_url FROM cms_banners WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?1) AND (ends_at IS NULL OR ends_at > ?1) ORDER BY sort, id LIMIT 10`).bind(now).all(),
		cards(db, {
			channel: "online",
			where: ["p.featured = 1"],
			limit: 8
		}),
		queryCards(db, {
			channel: "online",
			limit: 500
		}),
		db.prepare(`SELECT slug, title, excerpt, cover_key, published_at FROM cms_posts WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT 4`).all()
	]);
	const gids = [...new Set(all.map((x) => x.row.group_id).filter((x) => x != null))];
	const grp = gids.length ? (await db.prepare(`SELECT id, name FROM product_groups WHERE id IN (${gids.map(() => "?").join(",")}) ORDER BY name`).bind(...gids).all()).results : [];
	return c.json({
		banners: banners.results.map((b) => ({
			id: b.id,
			title: b.title,
			imageUrl: imageUrl(b.image_key),
			linkUrl: safeLink(b.link_url)
		})),
		featured,
		groups: grp.map((g) => ({
			id: g.id,
			name: g.name
		})),
		posts: posts.results.map((p) => ({
			slug: p.slug,
			title: p.title,
			excerpt: p.excerpt,
			coverUrl: imageUrl(p.cover_key),
			publishedAt: p.published_at
		}))
	});
});
catalogRoutes.get("/products", async (c) => {
	const db = c.env.DB;
	const q = c.req.query();
	const where = [];
	const binds = [];
	const ph = (v) => (binds.push(v), `?${4 + binds.length}`);
	if (q.q?.trim()) {
		const s = q.q.trim().slice(0, 60);
		where.push(`(p.name LIKE ${ph("%" + escapeLike(s) + "%")} ESCAPE '\\' OR p.slug LIKE ${ph("%" + escapeLike(normalizeVi(s).replace(/ /g, "-")) + "%")} ESCAPE '\\')`);
	}
	if (q.groupId && /^\d+$/.test(q.groupId)) where.push(`p.group_id = ${ph(Number(q.groupId))}`);
	const order = q.sort === "price_asc" ? "p.price ASC, p.id" : q.sort === "price_desc" ? "p.price DESC, p.id" : q.sort === "new" ? "p.id DESC" : "p.featured DESC, p.online_sort ASC, p.id ASC";
	const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
	const rows = await cards(db, {
		channel: "online",
		where,
		binds,
		order,
		limit: 25,
		offset
	});
	return c.json({
		items: rows.slice(0, PAGE),
		nextCursor: rows.length > PAGE ? String(offset + PAGE) : null
	});
});
catalogRoutes.get("/products/:slug", async (c) => {
	const db = c.env.DB;
	const [hit] = await queryCards(db, {
		channel: "online",
		where: ["p.slug = ?5"],
		binds: [c.req.param("slug").slice(0, 200)],
		limit: 1
	});
	if (!hit) throw notFound("product_not_found", "Không tìm thấy sản phẩm");
	const related = hit.row.group_id ? await cards(db, {
		channel: "online",
		where: ["p.group_id = ?5", "p.id <> ?6"],
		binds: [hit.row.group_id, hit.row.id],
		limit: 4
	}) : [];
	return c.json({
		...hit.card,
		description: hit.row.description ?? "",
		images: parseImages(hit.row.images_json).map((k) => `/img/${k}`),
		groupName: hit.row.group_name ?? null,
		related
	});
});
catalogRoutes.get("/posts/:slug", async (c) => {
	const p = await c.env.DB.prepare(`SELECT slug, title, excerpt, body_md, cover_key, published_at FROM cms_posts WHERE slug = ? AND status = 'published'`).bind(c.req.param("slug")).first();
	if (!p) throw notFound("post_not_found", "Không tìm thấy bài viết");
	return c.json({
		slug: p.slug,
		title: p.title,
		excerpt: p.excerpt,
		bodyMd: p.body_md,
		coverUrl: imageUrl(p.cover_key),
		publishedAt: p.published_at
	});
});
var IMG_TYPES = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	avif: "image/avif"
};
var imgRoutes = new Hono();
imgRoutes.get("/img/*", async (c) => {
	let key;
	try {
		key = decodeURIComponent(c.req.path.slice(5));
	} catch {
		throw notFound();
	}
	if (!key || key.includes("..") || key.includes("\\") || key.includes("\0") || key.startsWith("/") || key.includes("//") || !(key.startsWith("products/") || key.startsWith("cms/"))) throw notFound();
	const type = IMG_TYPES[key.split(".").pop().toLowerCase()];
	if (!type) throw notFound();
	const obj = await c.env.FILES.get(key);
	if (!obj) throw notFound();
	return new Response(obj.body, { headers: {
		"Content-Type": type,
		"Cache-Control": "public, max-age=86400",
		"X-Content-Type-Options": "nosniff",
		...obj.httpEtag ? { ETag: obj.httpEtag } : {}
	} });
});
var seoRoutes = new Hono();
seoRoutes.get("/robots.txt", (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${baseUrl(c)}/sitemap.xml\n`));
seoRoutes.get("/sitemap.xml", async (c) => {
	const db = c.env.DB;
	const base = baseUrl(c);
	const prods = await db.prepare(`SELECT slug FROM products WHERE active = 1 AND published_online = 1 AND slug IS NOT NULL AND merged_into IS NULL ORDER BY id LIMIT 5000`).all();
	const posts = await db.prepare(`SELECT slug, published_at FROM cms_posts WHERE status = 'published' ORDER BY id LIMIT 5000`).all();
	const url = (loc, lastmod) => `<url><loc>${escapeXml(base + loc)}</loc>${lastmod ? `<lastmod>${escapeXml(lastmod.slice(0, 10))}</lastmod>` : ""}</url>`;
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` + url("/") + prods.results.map((p) => url(`/san-pham/${encodeURIComponent(p.slug)}`)).join("") + posts.results.map((p) => url(`/bai-viet/${encodeURIComponent(p.slug)}`, p.published_at)).join("") + `</urlset>`;
	return c.body(xml, 200, {
		"Content-Type": "application/xml; charset=utf-8",
		"Cache-Control": "public, max-age=3600"
	});
});
// src/worker/services/outbox.ts
/** Đẩy các job queued của ref vừa commit lên Queue (best effort; cron sẽ quét lại nếu thất bại). */
async function kickJobs(env, refType, refId) {
	if (!env.JOBS) return;
	const { results } = await env.DB.prepare(`SELECT id FROM integration_jobs WHERE ref_type = ? AND ref_id = ? AND status = 'queued'`).bind(refType, refId).all();
	if (results.length) await env.JOBS.sendBatch(results.map((r) => ({ body: { jobId: r.id } })));
}
// src/shop/worker/routes/checkout.ts
var checkoutRoutes = new Hono();
var AddressSchema = objectType({
	receiverName: stringType().trim().min(1).max(100),
	receiverPhone: stringType().trim().min(8).max(20),
	addressLine: stringType().trim().min(1).max(200),
	ward: stringType().trim().max(100).optional().nullable(),
	district: stringType().trim().min(1).max(100),
	province: stringType().trim().min(1).max(100)
});
var CheckoutSchema = objectType({
	clientUuid: stringType().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
	items: arrayType(ItemSchema.extend({ expectedUnitPrice: numberType().int().nonnegative() })).min(1).max(50),
	address: unionType([objectType({ addressId: numberType().int().positive() }), AddressSchema]),
	slotDate: stringType().regex(DATE_RE),
	slotId: numberType().int().positive(),
	paymentMethod: enumType([
		"cod",
		"transfer",
		"gateway"
	]),
	note: stringType().trim().max(500).optional(),
	acceptPreorder: booleanType().optional(),
	email: stringType().trim().email().max(200).optional()
});
var isCheckFail$1 = (e) => /CHECK constraint failed/i.test(String(e?.message ?? ""));
var isUnique = (e) => /UNIQUE constraint failed/i.test(String(e?.message ?? ""));
var ORD = `(SELECT id FROM orders WHERE code = ?1)`;
/** Câu lệnh giữ tồn theo kế hoạch FEFO; order_line_id lấy theo thứ tự chèn dòng (vị trí) → cùng một batch với tạo đơn. */
function reserveByPosition(db, code, plans) {
	const s = [];
	for (const { pos, plan } of plans) for (const a of plan.alloc) s.push(db.prepare(`UPDATE lots SET qty_reserved_milli = qty_reserved_milli + ? WHERE id = ?`).bind(a.qtyMilli, a.lotId), db.prepare(`INSERT INTO reservations(order_id, order_line_id, lot_id, qty_milli)
             VALUES (${ORD}, (SELECT id FROM order_lines WHERE order_id = ${ORD} ORDER BY id LIMIT 1 OFFSET ?2), ?3, ?4)`).bind(code, pos, a.lotId, a.qtyMilli));
	return s;
}
checkoutRoutes.post("/checkout", optionalAuth, async (c) => {
	const db = c.env.DB;
	const b = await parseBody(c, CheckoutSchema);
	const account = c.get("account");
	const replay = async () => {
		const ex = await db.prepare(`SELECT * FROM orders WHERE client_uuid = ?`).bind(b.clientUuid).first();
		if (!ex) return null;
		if (ex.channel !== "online" || (ex.shop_account_id ?? null) !== (account?.id ?? null)) throw conflict("duplicate_client_uuid", "Mã yêu cầu đã được dùng");
		return c.json(await orderView(db, ex), 200);
	};
	const r0 = await replay();
	if (r0) return r0;
	if (!account) await verifyTurnstile(c);
	let addr;
	if ("addressId" in b.address) {
		if (!account) throw new AppError(401, "unauthenticated", "Vui lòng đăng nhập để dùng sổ địa chỉ");
		const a = await db.prepare(`SELECT receiver_name, receiver_phone, address_line, ward, district, province FROM shop_addresses WHERE id = ? AND account_id = ? AND active = 1`).bind(b.address.addressId, account.id).first();
		if (!a) throw new AppError(404, "address_not_found", "Không tìm thấy địa chỉ");
		addr = {
			receiverName: a.receiver_name,
			receiverPhone: a.receiver_phone,
			addressLine: a.address_line,
			ward: a.ward,
			district: a.district,
			province: a.province
		};
	} else addr = b.address;
	const phone = normalizePhone(addr.receiverPhone);
	if (!phone) throw new AppError(422, "invalid_phone", "Số điện thoại không hợp lệ");
	const zone = await findZone(db, addr.district);
	if (!zone) throw new AppError(422, "zone_unsupported", "Chưa hỗ trợ giao hàng tới khu vực này");
	if (b.slotDate > addDaysStr(vnDate(), 14)) throw new AppError(422, "invalid_slot", "Chỉ nhận đặt giao trong 14 ngày tới");
	const slot = await getSlot(db, b.slotId);
	if (!slot) throw new AppError(422, "invalid_slot", "Khung giờ giao không tồn tại");
	const why = await slotProblem(db, slot, b.slotDate);
	if (why === "full") throw conflict("slot_full", "Khung giờ đã đầy, vui lòng chọn khung khác");
	if (why === "cutoff" || why === "past") throw conflict("slot_cutoff", "Đã quá giờ chốt đặt cho khung giờ này");
	if (why === "closed") throw new AppError(422, "slot_closed", "Khung giờ không giao vào ngày này");
	const { lines, issues } = await priceCart(db, b.items);
	if (issues.length) throw new AppError(422, "product_unavailable", "Có sản phẩm không còn bán online", { issues });
	const changed = lines.filter((l) => l.expectedUnitPrice !== l.unitPrice);
	if (changed.length) throw conflict("price_changed", "Giá đã thay đổi, vui lòng kiểm tra lại giỏ hàng", { lines: changed.map((l) => ({
		productId: l.productId,
		oldPrice: l.expectedUnitPrice,
		newPrice: l.unitPrice
	})) });
	const totals = await computeTotals(db, lines, addr.district);
	if (totals.subtotal < zone.minOrder) throw new AppError(422, "min_order", `Đơn tối thiểu ${zone.minOrder.toLocaleString("vi-VN")}đ`, {
		minOrder: zone.minOrder,
		subtotal: totals.subtotal
	});
	if (!(await setting(db, "payment.methods", "cod,transfer")).split(",").map((x) => x.trim()).includes(b.paymentMethod)) throw new AppError(422, "payment_method_unavailable", "Hình thức thanh toán này hiện chưa được hỗ trợ");
	if (b.paymentMethod === "transfer" && !await setting(db, "payment.bank_account", "")) throw new AppError(422, "payment_method_unavailable", "Chuyển khoản tạm thời chưa khả dụng, vui lòng chọn hình thức khác");
	const holdMinutes = await settingNum(db, "online.hold_minutes_transfer", 30);
	const autoConfirm = await setting(db, "online.auto_confirm", "0") === "1";
	const storeId = await onlineStoreId(db);
	const code = await nextCode(db, "DH");
	const guestCustomerCode = account ? null : await nextCode(db, "KL");
	const token = newTrackingToken();
	const groupId = (await db.prepare(`SELECT id FROM customer_groups WHERE code = 'le'`).first())?.id ?? null;
	const shipAddress = [
		addr.addressLine,
		addr.ward,
		addr.district,
		addr.province
	].filter(Boolean).join(", ");
	const link = `${baseUrl(c)}/track/${token}`;
	for (let attempt = 0;; attempt++) {
		const short = await applyStock(db, storeId, lines);
		for (const s of short) if (!s.line.allowPreorder || !b.acceptPreorder) throw conflict("insufficient_stock", "Không đủ hàng cho một số sản phẩm", {
			productId: s.line.productId,
			availableMilli: publicRemaining(s.line, s.remainingBefore)
		});
		const isPreorder = lines.some((l) => l.preorderMilli > 0);
		let plans = [];
		try {
			const covered = lines.map((l, pos) => ({
				l,
				pos
			})).filter((x) => x.l.coveredMilli > 0);
			plans = (covered.length ? await planReservations(db, covered.map((x) => ({
				orderLineId: x.pos,
				productId: x.l.productId,
				qtyMilli: x.l.coveredMilli
			})), storeId) : []).map((plan, i) => ({
				pos: covered[i].pos,
				plan
			}));
		} catch (e) {
			if (e instanceof AppError && e.code === "insufficient_stock" && attempt === 0) continue;
			throw e;
		}
		const status = b.paymentMethod === "cod" ? autoConfirm && !isPreorder ? "confirmed" : "new" : "awaiting_payment";
		const payStatus = b.paymentMethod === "cod" ? "unpaid" : "pending";
		const stmts = [];
		if (guestCustomerCode) stmts.push(db.prepare(`INSERT INTO customers(code, type, name, phone, email, customer_group_id, created_at) VALUES (?, 'retail', ?, ?, ?, ?, ?)`).bind(guestCustomerCode, addr.receiverName, phone, b.email ?? null, groupId, (/* @__PURE__ */ new Date()).toISOString()));
		stmts.push(db.prepare(`INSERT INTO orders(code, client_uuid, channel, kind, store_id, customer_id, status, is_preorder, subtotal, discount, shipping_fee, total, note,
                              shop_account_id, tracking_token, receiver_name, receiver_phone, ship_address, zone_id, slot_date, slot_id,
                              payment_method, payment_status, estimated_total, weight_adjust_status)
           VALUES (?,?,'online','sale',?, COALESCE(?, (SELECT id FROM customers WHERE code = ?)), ?,?,?,0,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,'none')`).bind(code, b.clientUuid, storeId, account?.customerId ?? null, guestCustomerCode, status, isPreorder ? 1 : 0, totals.subtotal, totals.shippingFee, totals.total, b.note ?? null, account?.id ?? null, token, addr.receiverName, phone, shipAddress, zone.id, b.slotDate, b.slotId, b.paymentMethod, payStatus, totals.total));
		for (const l of lines) stmts.push(db.prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, line_total, ordered_qty_milli, preorder_milli)
             VALUES (${ORD}, ?2, ?3, ?4, ?5, ?6, ?4, ?7)`).bind(code, l.productId, l.unit, l.qtyMilli, l.unitPrice, l.lineTotal, l.preorderMilli));
		stmts.push(...reserveByPosition(db, code, plans));
		const ev = (st, note) => db.prepare(`INSERT INTO order_events(order_id, status, note, actor_type, actor_id) VALUES (${ORD}, ?2, ?3, 'customer', ?4)`).bind(code, st, note, account?.id ?? null);
		if (status === "confirmed") stmts.push(ev("new", "Đặt hàng thành công"), ev("confirmed", "Đơn được tự động xác nhận"));
		else stmts.push(ev(status, status === "awaiting_payment" ? "Đặt hàng thành công, chờ thanh toán" : "Đặt hàng thành công"));
		if (b.paymentMethod !== "cod") {
			const expires = new Date(Date.now() + holdMinutes * 6e4).toISOString();
			stmts.push(db.prepare(`INSERT INTO payment_intents(order_id, provider, amount, transfer_content, provider_ref, expires_at) VALUES (${ORD}, ?2, ?3, ?4, ?5, ?6)`).bind(code, b.paymentMethod === "transfer" ? "vietqr" : "fake_gateway", totals.total, `HM ${code.replaceAll("-", "")}`, b.paymentMethod === "gateway" ? code : null, expires));
		}
		stmts.push(enqueueByRef(db, "notify.order_status", "order", code, {
			orderCode: code,
			status,
			accountId: account?.id ?? null,
			email: account ? null : b.email ?? null,
			link
		}), enqueueByRef(db, "notify.staff_new_order", "order", code, {
			orderCode: code,
			total: totals.total,
			isPreorder
		}));
		try {
			await db.batch(stmts);
		} catch (e) {
			if (isUnique(e)) {
				const r = await replay();
				if (r) return r;
			}
			if (isCheckFail$1(e)) {
				if (attempt === 0) continue;
				throw conflict("insufficient_stock", "Không đủ hàng (tồn vừa thay đổi), vui lòng thử lại");
			}
			throw e;
		}
		const row = await db.prepare(`SELECT * FROM orders WHERE code = ?`).bind(code).first();
		try {
			await kickJobs(c.env, "order", row.id);
		} catch {}
		return c.json(await orderView(db, row), 201);
	}
});
// src/shop/worker/routes/me.ts
var meRoutes = new Hono();
meRoutes.use("/me", requireAccount);
meRoutes.use("/me/addresses", requireAccount);
meRoutes.use("/me/addresses/*", requireAccount);
meRoutes.use("/me/push-subscriptions", requireAccount);
meRoutes.get("/me", (c) => c.json(meShape(c.get("account"))));
meRoutes.put("/me", async (c) => {
	const a = c.get("account");
	const b = await parseBody(c, objectType({
		fullName: stringType().trim().min(1).max(100).optional(),
		phone: stringType().trim().min(8).max(20).optional(),
		marketingOptIn: booleanType().optional()
	}));
	const phone = b.phone ? normalizePhone(b.phone) : void 0;
	if (b.phone && !phone) throw new AppError(422, "invalid_phone", "Số điện thoại không hợp lệ");
	const db = c.env.DB;
	const full = b.fullName ?? a.fullName;
	const ph = phone ?? a.phone;
	const stmts = [db.prepare(`UPDATE shop_accounts SET full_name = ?, phone = ?, marketing_opt_in = ? WHERE id = ?`).bind(full, ph, b.marketingOptIn ?? a.marketingOptIn ? 1 : 0, a.id)];
	if (a.kind === "retail") stmts.push(db.prepare(`UPDATE customers SET name = ?, phone = ? WHERE id = ? AND type = 'retail'`).bind(full, ph, a.customerId));
	await db.batch(stmts);
	return c.json(meShape({
		...a,
		fullName: full,
		phone: ph,
		marketingOptIn: b.marketingOptIn ?? a.marketingOptIn
	}));
});
/**
* NĐ 13/2023 (quyền xoá dữ liệu): ẩn danh hoá tài khoản. Yêu cầu nhập lại mật khẩu (chống xoá do phiên bị chiếm).
*  - XOÁ/ẩn danh: shop_accounts (tên, email, SĐT, hash mật khẩu), shop_addresses, shop_sessions, shop_tokens, push_subscriptions,
*    và hồ sơ customers loại retail của chính tài khoản (tên/SĐT/email).
*  - GIỮ: orders/order_lines/payments/order_events — chứng từ kế toán phải lưu theo Luật Kế toán; trường người nhận trên đơn
*    (receiver_name/phone, ship_address) được giữ để đối soát giao hàng. [Cần xác nhận] thời hạn lưu trữ & ẩn danh hoá nốt sau thời hạn.
*  - Không cho xoá khi còn đơn đang xử lý.
*/
meRoutes.delete("/me", async (c) => {
	const a = c.get("account");
	const db = c.env.DB;
	const b = await parseBody(c, objectType({ password: stringType().min(1).max(128) }));
	const row = await db.prepare(`SELECT pass_hash FROM shop_accounts WHERE id = ?`).bind(a.id).first();
	if (!row || !await verifyPassword(b.password, row.pass_hash)) throw new AppError(403, "invalid_password", "Mật khẩu không đúng");
	if (((await db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE shop_account_id = ? AND status NOT IN ('completed','cancelled','returned')`).bind(a.id).first())?.n ?? 0) > 0) throw conflict("active_orders", "Bạn còn đơn hàng đang xử lý, vui lòng chờ hoàn tất hoặc huỷ trước khi xoá tài khoản");
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const stmts = [
		db.prepare(`UPDATE shop_accounts SET email = ?, phone = NULL, full_name = 'Tài khoản đã xoá', pass_hash = '!deleted', active = 0, marketing_opt_in = 0, email_verified_at = NULL, deleted_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?`).bind(`deleted+${a.id}@deleted.invalid`, now, a.id),
		db.prepare(`DELETE FROM shop_addresses WHERE account_id = ?`).bind(a.id),
		db.prepare(`DELETE FROM push_subscriptions WHERE account_id = ?`).bind(a.id),
		db.prepare(`DELETE FROM shop_tokens WHERE account_id = ?`).bind(a.id),
		db.prepare(`UPDATE shop_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`).bind(now, a.id),
		sysAuditStmt(db, {
			action: "shop.account_delete",
			entity: "shop_account",
			entityId: a.id,
			after: {
				customerId: a.customerId,
				anonymized: true
			}
		})
	];
	if (a.kind === "retail") stmts.push(db.prepare(`UPDATE customers SET name = ?, phone = NULL, email = NULL, active = 0 WHERE id = ? AND type = 'retail'`).bind(`Khách đã xoá #${a.id}`, a.customerId));
	await db.batch(stmts);
	deleteCookie(c, SESSION_COOKIE, {
		path: "/",
		secure: true
	});
	return c.json({ ok: true });
});
var AddrBody = AddressSchema.extend({
	label: stringType().trim().max(50).optional().nullable(),
	isDefault: booleanType().optional()
});
var addrOut = (r) => ({
	id: r.id,
	label: r.label,
	receiverName: r.receiver_name,
	receiverPhone: r.receiver_phone,
	addressLine: r.address_line,
	ward: r.ward,
	district: r.district,
	province: r.province,
	zoneId: r.zone_id,
	isDefault: !!r.is_default
});
meRoutes.get("/me/addresses", async (c) => {
	const { results } = await c.env.DB.prepare(`SELECT * FROM shop_addresses WHERE account_id = ? AND active = 1 ORDER BY is_default DESC, id`).bind(c.get("account").id).all();
	return c.json({ items: results.map(addrOut) });
});
async function saveAddress(c, id) {
	const a = c.get("account");
	const db = c.env.DB;
	const b = await parseBody(c, AddrBody);
	const phone = normalizePhone(b.receiverPhone);
	if (!phone) throw new AppError(422, "invalid_phone", "Số điện thoại không hợp lệ");
	const zone = await findZone(db, b.district);
	const count = (await db.prepare(`SELECT COUNT(*) n FROM shop_addresses WHERE account_id = ? AND active = 1`).bind(a.id).first()).n;
	if (id == null && count >= 20) throw new AppError(422, "too_many_addresses", "Tối đa 20 địa chỉ");
	const makeDefault = b.isDefault || id == null && count === 0;
	const stmts = [];
	if (makeDefault) stmts.push(db.prepare(`UPDATE shop_addresses SET is_default = 0 WHERE account_id = ?`).bind(a.id));
	if (id == null) stmts.push(db.prepare(`INSERT INTO shop_addresses(account_id, label, receiver_name, receiver_phone, address_line, ward, district, province, zone_id, is_default) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(a.id, b.label ?? null, b.receiverName, phone, b.addressLine, b.ward ?? null, b.district, b.province, zone?.id ?? null, makeDefault ? 1 : 0));
	else {
		const own = await db.prepare(`SELECT is_default FROM shop_addresses WHERE id = ? AND account_id = ? AND active = 1`).bind(id, a.id).first();
		if (!own) throw notFound("address_not_found", "Không tìm thấy địa chỉ");
		stmts.push(db.prepare(`UPDATE shop_addresses SET label=?, receiver_name=?, receiver_phone=?, address_line=?, ward=?, district=?, province=?, zone_id=?, is_default=? WHERE id=? AND account_id=?`).bind(b.label ?? null, b.receiverName, phone, b.addressLine, b.ward ?? null, b.district, b.province, zone?.id ?? null, makeDefault || own.is_default ? 1 : 0, id, a.id));
	}
	const res = await db.batch(stmts);
	const rid = id ?? res[res.length - 1].meta.last_row_id ?? 0;
	const row = await db.prepare(`SELECT * FROM shop_addresses WHERE id = ?`).bind(rid).first();
	return c.json(addrOut(row), id == null ? 201 : 200);
}
meRoutes.post("/me/addresses", (c) => saveAddress(c, null));
meRoutes.put("/me/addresses/:id", (c) => saveAddress(c, Number(c.req.param("id"))));
meRoutes.delete("/me/addresses/:id", async (c) => {
	if (!(await c.env.DB.prepare(`UPDATE shop_addresses SET active = 0, is_default = 0 WHERE id = ? AND account_id = ? AND active = 1`).bind(Number(c.req.param("id")), c.get("account").id).run()).meta.changes) throw notFound("address_not_found", "Không tìm thấy địa chỉ");
	return c.json({ ok: true });
});
meRoutes.post("/me/push-subscriptions", async (c) => {
	const b = await parseBody(c, objectType({
		endpoint: stringType().url().max(600).refine((u) => u.startsWith("https://"), "endpoint phải là https"),
		keys: objectType({
			p256dh: stringType().min(10).max(200),
			auth: stringType().min(10).max(100)
		})
	}));
	await c.env.DB.prepare(`INSERT INTO push_subscriptions(account_id, endpoint, p256dh, auth) VALUES (?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET account_id = excluded.account_id, user_id = NULL, p256dh = excluded.p256dh, auth = excluded.auth, last_error = NULL`).bind(c.get("account").id, b.endpoint, b.keys.p256dh, b.keys.auth).run();
	return c.json({ ok: true }, 201);
});
meRoutes.get("/push/vapid-public-key", (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? null }));
// src/shop/worker/routes/orders.ts
var orderRoutes = new Hono();
var isCheckFail = (e) => /CHECK constraint failed/i.test(String(e?.message ?? ""));
orderRoutes.get("/orders/track/:token", async (c) => {
	const o = await findByTracking(c.env.DB, c.req.param("token"), c.req.query("phone4"));
	if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
	return c.json(await orderView(c.env.DB, o));
});
orderRoutes.post("/orders/track/:token/weight-decision", async (c) => {
	const db = c.env.DB;
	const b = await parseBody(c, objectType({
		accept: booleanType(),
		phone4: stringType().regex(/^\d{4}$/).optional()
	}));
	const o = await findByTracking(db, c.req.param("token"), b.phone4 ?? c.req.query("phone4"));
	if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
	if (o.weight_adjust_status !== "pending_customer") throw conflict("no_pending_decision", "Đơn không có yêu cầu xác nhận khối lượng");
	const actor = {
		type: "customer",
		id: o.shop_account_id ?? null
	};
	try {
		if (b.accept) await db.batch([
			db.prepare(`UPDATE orders SET weight_adjust_status = 'accepted' WHERE id = ? AND weight_adjust_status = 'pending_customer'`).bind(o.id),
			db.prepare(`INSERT INTO order_events(order_id, status, note, actor_type, actor_id) VALUES (?, ?, 'Khách đồng ý giá theo khối lượng thực tế', 'customer', ?)`).bind(o.id, o.status, actor.id),
			enqueueByRef(db, "notify.staff_new_order", "order", o.code, {
				orderCode: o.code,
				event: "weight_accepted"
			})
		]);
		else await db.batch([
			...await releaseOrderStmts(db, o.id),
			...transitionStmts(db, o.id, o.status, "cancelled", actor, {
				note: "Khách không đồng ý giá theo khối lượng thực tế, đơn đã huỷ",
				extraSet: "weight_adjust_status = 'rejected', cancel_reason = ?3",
				extraBinds: ["Khách từ chối chênh lệch khối lượng"]
			}),
			db.prepare(`UPDATE payment_intents SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'`).bind(o.id),
			enqueueByRef(db, "notify.order_status", "order", o.code, {
				orderCode: o.code,
				status: "cancelled",
				accountId: o.shop_account_id ?? null,
				link: `${baseUrl(c)}/track/${o.tracking_token}`
			})
		]);
	} catch (e) {
		if (isCheckFail(e)) throw conflict("invalid_transition", "Đơn vừa thay đổi trạng thái, vui lòng tải lại");
		throw e;
	}
	const fresh = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(o.id).first();
	try {
		await kickJobs(c.env, "order", o.id);
	} catch {}
	return c.json(await orderView(db, fresh));
});
orderRoutes.get("/me/orders", requireAccount, async (c) => {
	const w = ownedWhere(c.get("account"));
	const { results } = await c.env.DB.prepare(`SELECT o.* FROM orders o WHERE (${w.sql}) ORDER BY o.id DESC LIMIT 100`).bind(...w.binds).all();
	return c.json(await Promise.all(results.map((o) => orderView(c.env.DB, o))));
});
orderRoutes.get("/me/orders/:code", requireAccount, async (c) => {
	const o = await findOwnedOrder(c.env.DB, c.get("account"), c.req.param("code"));
	if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
	return c.json(await orderView(c.env.DB, o));
});
orderRoutes.post("/me/orders/:code/cancel", requireAccount, async (c) => {
	const db = c.env.DB;
	const a = c.get("account");
	const o = await findOwnedOrder(db, a, c.req.param("code"));
	if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
	if (o.channel !== "online" || !CANCELLABLE.includes(o.status)) throw conflict("not_cancellable", "Đơn không thể huỷ ở trạng thái hiện tại, vui lòng liên hệ cửa hàng", { status: o.status });
	const paid = o.payment_status === "paid" || o.payment_status === "partially_refunded";
	try {
		await db.batch([
			...await releaseOrderStmts(db, o.id),
			...transitionStmts(db, o.id, o.status, "cancelled", {
				type: "customer",
				id: a.id
			}, {
				note: "Khách huỷ đơn",
				internalNote: paid ? "Đơn đã thanh toán trước khi khách huỷ: cần hoàn tiền cho khách" : void 0,
				extraSet: "cancel_reason = ?3",
				extraBinds: ["Khách tự huỷ"]
			}),
			db.prepare(`UPDATE payment_intents SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'`).bind(o.id),
			...paid ? [sysAuditStmt(db, {
				action: "shop.order_cancel_refund_needed",
				entity: "order",
				entityId: o.code,
				after: {
					paymentStatus: o.payment_status,
					total: o.total
				}
			})] : [],
			enqueueByRef(db, "notify.order_status", "order", o.code, {
				orderCode: o.code,
				status: "cancelled",
				accountId: a.id,
				link: `${baseUrl(c)}/track/${o.tracking_token}`
			})
		]);
	} catch (e) {
		if (isCheckFail(e)) throw conflict("invalid_transition", "Đơn vừa thay đổi trạng thái, vui lòng tải lại");
		throw e;
	}
	try {
		await kickJobs(c.env, "order", o.id);
	} catch {}
	const fresh = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(o.id).first();
	return c.json(await orderView(db, fresh));
});
/** M8-07: trả các dòng của đơn cũ theo giá/tồn hiện tại để đưa vào giỏ. */
orderRoutes.post("/me/orders/:code/reorder", requireAccount, async (c) => {
	const db = c.env.DB;
	const o = await findOwnedOrder(db, c.get("account"), c.req.param("code"));
	if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
	const lines = (await db.prepare(`SELECT ol.product_id, ol.unit, COALESCE(ol.ordered_qty_milli, ol.qty_milli) AS q,
                COALESCE((SELECT pu.factor_milli FROM product_units pu WHERE pu.product_id = ol.product_id AND pu.unit = ol.unit), 1000) AS factor, p.name
           FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`).bind(o.id).all()).results;
	const ids = [...new Set(lines.map((l) => l.product_id))];
	const live = ids.length ? await cards(db, {
		channel: "online",
		where: [`p.id IN (${ids.map((_, i) => `?${5 + i}`).join(",")})`],
		binds: ids
	}) : [];
	const byId = new Map(live.map((p) => [p.id, p]));
	const items = [];
	const unavailable = [];
	for (const l of lines) {
		const p = byId.get(l.product_id);
		if (!p) {
			unavailable.push({
				productId: l.product_id,
				name: l.name
			});
			continue;
		}
		items.push({
			productId: p.id,
			slug: p.slug,
			name: p.name,
			unit: l.unit,
			qty: l.q / l.factor,
			unitPrice: p.price,
			imageUrl: p.imageUrl,
			inStock: p.inStock,
			stepMilli: p.stepMilli
		});
	}
	return c.json({
		items,
		unavailable
	});
});
orderRoutes.get("/payments/:orderCode/transfer", async (c) => {
	const db = c.env.DB;
	const code = c.req.param("orderCode");
	const o = await db.prepare(`SELECT * FROM orders WHERE code = ? AND channel = 'online'`).bind(code).first();
	let allowed = false;
	const token = c.req.query("token");
	if (o && token && o.tracking_token && token.length === o.tracking_token.length) allowed = token === o.tracking_token;
	if (o && !allowed) {
		const t = sessionTokenOf(c);
		const a = t ? await loadAccount(c.env, t) : null;
		allowed = !!a && o.shop_account_id === a.id;
	}
	if (!o || !allowed) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
	if (o.payment_status === "paid") throw conflict("already_paid", "Đơn đã được thanh toán");
	const info = await transferInfoFor(db, o);
	if (!info) throw conflict("no_pending_transfer", "Đơn không có yêu cầu chuyển khoản đang chờ");
	if (info.expiresAt && info.expiresAt < (/* @__PURE__ */ new Date()).toISOString()) throw conflict("intent_expired", "Yêu cầu chuyển khoản đã hết hạn");
	if (!info.accountNo) throw new AppError(409, "payment_method_unavailable", "Chuyển khoản tạm thời chưa khả dụng");
	return c.json(info);
});
// src/shop/worker/routes/payments.ts
var paymentRoutes = new Hono();
var FAKE = "fake_gateway";
var TOLERANCE_S = 300;
var toHex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
var fromHex = (h) => /^[0-9a-f]+$/i.test(h) && h.length % 2 === 0 ? Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16))) : /* @__PURE__ */ new Uint8Array();
async function hmacHex(secret, body) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {
		name: "HMAC",
		hash: "SHA-256"
	}, false, ["sign"]);
	return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}
var FakeEventSchema = objectType({
	eventId: stringType().min(1).max(100),
	orderCode: stringType().min(1).max(40),
	amount: numberType().int().nonnegative(),
	status: enumType(["succeeded", "failed"])
});
/** Cổng giả lập cho dev/staging: HMAC-SHA256 (hex) của body thô bằng PAYMENT_WEBHOOK_SECRET; header x-signature + x-timestamp (giây). */
var fakeGateway = {
	provider: FAKE,
	async verifyWebhook(raw, headers, env) {
		if (!env.PAYMENT_WEBHOOK_SECRET) throw httpError(503, "webhook_not_configured", "Chưa cấu hình PAYMENT_WEBHOOK_SECRET");
		const ts = Number(headers.get("x-timestamp"));
		if (!Number.isFinite(ts) || Math.abs(Date.now() / 1e3 - ts) > TOLERANCE_S) throw httpError(401, "bad_timestamp", "Timestamp webhook không hợp lệ hoặc quá hạn");
		const sig = fromHex((headers.get("x-signature") ?? "").trim());
		const want = fromHex(await hmacHex(env.PAYMENT_WEBHOOK_SECRET, raw));
		if (!sig.length || !timingSafeEqual(sig, want)) throw httpError(401, "bad_signature", "Chữ ký webhook không hợp lệ");
		let json;
		try {
			json = JSON.parse(raw);
		} catch {
			throw new AppError(400, "invalid_json", "Body webhook không phải JSON");
		}
		return FakeEventSchema.parse(json);
	}
};
var GATEWAYS = { [FAKE]: fakeGateway };
paymentRoutes.post("/payments/gateway/:provider/webhook", async (c) => {
	const adapter = GATEWAYS[c.req.param("provider")];
	if (!adapter) throw new AppError(501, "gateway_not_supported", "Cổng thanh toán chưa được hỗ trợ");
	const db = c.env.DB;
	const raw = await c.req.text();
	const ev = await adapter.verifyWebhook(raw, c.req.raw.headers, c.env);
	const source = `payment:${adapter.provider}`;
	if (await db.prepare(`SELECT id FROM webhook_events WHERE source = ? AND event_id = ?`).bind(source, ev.eventId).first()) return c.json({
		ok: true,
		duplicate: true
	});
	const record = (result) => db.prepare(`INSERT INTO webhook_events(source, event_id, payload_json, result) VALUES (?,?,?,?)`).bind(source, ev.eventId, JSON.stringify({
		orderCode: ev.orderCode,
		amount: ev.amount,
		status: ev.status
	}), result);
	const o = await db.prepare(`SELECT id, code, status, total, shop_account_id, tracking_token FROM orders WHERE code = ? AND channel = 'online'`).bind(ev.orderCode).first();
	const intent = o ? await db.prepare(`SELECT id, amount, status FROM payment_intents WHERE order_id = ? AND provider = ? ORDER BY id DESC LIMIT 1`).bind(o.id, adapter.provider).first() : null;
	let result = "processed";
	const stmts = [];
	if (!o || !intent) result = "ignored:no_intent";
	else if (intent.status !== "pending" || o.status !== "awaiting_payment") {
		result = "ignored:not_pending";
		stmts.push(sysAuditStmt(db, {
			action: "shop.payment_late",
			entity: "order",
			entityId: o.code,
			after: {
				eventId: ev.eventId,
				orderStatus: o.status,
				intentStatus: intent.status,
				amount: ev.amount
			}
		}));
	} else if (ev.status === "failed") {
		result = "failed";
		stmts.push(db.prepare(`UPDATE payment_intents SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'pending'`).bind((/* @__PURE__ */ new Date()).toISOString(), intent.id));
	} else if (ev.amount !== intent.amount) {
		result = "ignored:amount_mismatch";
		stmts.push(sysAuditStmt(db, {
			action: "shop.payment_amount_mismatch",
			entity: "order",
			entityId: o.code,
			after: {
				eventId: ev.eventId,
				expected: intent.amount,
				got: ev.amount
			}
		}));
	} else {
		const fund = await db.prepare(`SELECT id FROM funds WHERE type = 'bank' AND active = 1 ORDER BY id LIMIT 1`).first();
		const now = (/* @__PURE__ */ new Date()).toISOString();
		stmts.push(db.prepare(`UPDATE payment_intents SET status = 'succeeded', completed_at = ? WHERE id = ? AND status = 'pending'`).bind(now, intent.id), db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?, 'transfer', ?, ?, ?, 'confirmed')`).bind(o.id, ev.amount, fund?.id ?? null, `${adapter.provider}:${ev.eventId}`), ...transitionStmts(db, o.id, "awaiting_payment", "new", { type: "system" }, {
			note: "Đã nhận thanh toán",
			extraSet: "payment_status = 'paid', paid_total = ?3",
			extraBinds: [ev.amount]
		}), enqueueByRef(db, "notify.order_status", "order", o.code, {
			orderCode: o.code,
			status: "new",
			accountId: o.shop_account_id ?? null
		}), enqueueByRef(db, "notify.staff_new_order", "order", o.code, {
			orderCode: o.code,
			total: o.total,
			paid: true
		}));
	}
	try {
		await db.batch([record(result), ...stmts]);
	} catch (e) {
		if (/UNIQUE constraint failed/i.test(String(e?.message))) return c.json({
			ok: true,
			duplicate: true
		});
		throw e;
	}
	if (result === "processed" && o) try {
		await kickJobs(c.env, "order", o.id);
	} catch {}
	return c.json({
		ok: true,
		result
	});
});
/** Người dùng quay lại từ cổng: chỉ báo trạng thái (không đổi gì); trạng thái thật do webhook quyết định. */
paymentRoutes.all("/payments/gateway/:provider/return", async (c) => {
	if (!GATEWAYS[c.req.param("provider")]) throw new AppError(501, "gateway_not_supported", "Cổng thanh toán chưa được hỗ trợ");
	const code = c.req.query("order") ?? "";
	const token = c.req.query("token") ?? "";
	const o = await c.env.DB.prepare(`SELECT code, payment_status, status FROM orders WHERE code = ? AND tracking_token = ? AND channel = 'online'`).bind(code, token).first();
	if (!o) throw new AppError(404, "order_not_found", "Không tìm thấy đơn hàng");
	return c.json({
		orderCode: o.code,
		paymentStatus: o.payment_status,
		status: o.status
	});
});
// src/shop/worker/index.ts
var app = new Hono();
app.use("*", async (c, next) => {
	c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());
	c.set("account", null);
	await next();
});
app.use("*", secureHeaders({
	contentSecurityPolicy: {
		defaultSrc: ["'self'"],
		scriptSrc: ["'self'", "https://challenges.cloudflare.com"],
		styleSrc: ["'self'", "'unsafe-inline'"],
		imgSrc: [
			"'self'",
			"data:",
			"blob:"
		],
		connectSrc: ["'self'", "https://challenges.cloudflare.com"],
		frameSrc: ["https://challenges.cloudflare.com"],
		frameAncestors: ["'none'"],
		baseUri: ["'self'"],
		formAction: ["'self'"]
	},
	strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
	referrerPolicy: "strict-origin-when-cross-origin",
	permissionsPolicy: {
		camera: [],
		geolocation: [],
		microphone: []
	}
}));
app.use("/api/*", bodyLimit({
	maxSize: 1048576,
	onError: () => {
		throw new AppError(422, "payload_too_large", "Dữ liệu quá lớn");
	}
}));
app.use("/api/*", async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
});
app.use("/api/*", rateLimit);
app.use("/api/*", csrfGuard);
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", authRoutes);
app.route("/api", catalogRoutes);
app.route("/api", cartRoutes);
app.route("/api", checkoutRoutes);
app.route("/api", orderRoutes);
app.route("/api", paymentRoutes);
app.route("/api", meRoutes);
app.route("/api", b2bRoutes);
app.route("/", imgRoutes);
app.route("/", seoRoutes);
app.all("/api/*", (c) => c.json({ error: {
	code: "not_found",
	message: "Không tìm thấy"
} }, 404));
app.onError(onError);
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
// \0virtual:cloudflare/worker-entry
var worker_entry_default = { fetch: app.fetch };
export { app, worker_entry_default as default };

//# sourceMappingURL=index.js.map