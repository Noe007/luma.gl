/* eslint-disable no-inline-comments */
import {GL} from './api';
import {assertWebGL2Context, isWebGL2Context} from './api';
import * as VertexAttributes from './vertex-attributes';
import Resource from './resource';
import Buffer from './buffer';
import Texture from './texture';
import {parseUniformName, getUniformSetter} from './uniforms';
import {VertexShader, FragmentShader} from './shader';
import SHADERS from '../../shaderlib';
import {log, uid} from '../utils';

export default class Program extends Resource {

  static PARAMETERS = [
    GL.DELETE_STATUS, // GLboolean
    GL.LINK_STATUS, // GLboolean
    GL.VALIDATE_STATUS, // GLboolean
    GL.ATTACHED_SHADERS, // GLint
    GL.ACTIVE_ATTRIBUTES, // GLint
    GL.ACTIVE_UNIFORMS, // GLint
    GL.TRANSFORM_FEEDBACK_BUFFER_MODE, // SEPARATE_ATTRIBS/INTERLEAVED_ATTRIBS
    GL.TRANSFORM_FEEDBACK_VARYINGS, // GLint
    GL.ACTIVE_UNIFORM_BLOCKS // GLint
  ];

  /*
   * @classdesc
   * Handles creation of programs, mapping of attributes and uniforms
   *
   * @class
   * @param {WebGLRenderingContext} gl - gl context
   * @param {Object} opts - options
   * @param {String} opts.vs - Vertex shader source
   * @param {String} opts.fs - Fragment shader source
   * @param {String} opts.id= - Id
   */
  /* eslint-disable max-statements */
  constructor(gl, opts = {}) {
    super(gl, opts);
    this.initialize(opts);
    Object.seal(this);
  }
  /* eslint-enable max-statements */

  initialize({
    vs = SHADERS.DEFAULT.vs,
    fs = SHADERS.DEFAULT.fs,
    defaultUniforms
  } = {}) {
    // If program is not named, name it after shader names
    let programName = vs.getName() || fs.getName();
    programName = programName ? `${programName}-program` : 'program';
    this.id = this.id || uid(programName);

    // Assign default uniforms if any of the default shaders is being used
    if (vs === SHADERS.DEFAULT.vs || fs === SHADERS.DEFAULT.fs &&
      defaultUniforms === undefined
    ) {
      defaultUniforms = SHADERS.DEFAULT.defaultUniforms;
    }

    vs = new VertexShader(this.gl, vs);
    fs = new FragmentShader(this.gl, fs);

    // Create shaders
    this.opts.vs = vs;
    this.opts.fs = fs;
    this.opts.defaultUniforms = defaultUniforms;
  }

  use() {
    this.gl.useProgram(this.handle);
    return this;
  }

  // A good thing about webGL is that there are so many ways to draw things,
  // e.g. depending on whether data is indexed and/or isInstanced.
  // This function unifies those into a single call with simple parameters
  // that have sane defaults.
  draw(gl, {
    drawMode = GL.TRIANGLES,
    vertexCount,
    offset = 0,
    isIndexed = false,
    indexType = GL.UNSIGNED_SHORT,
    isInstanced = false,
    instanceCount = 0
  }) {
    this.use();

    const extension = gl.getExtension('ANGLE_instanced_arrays');

    // TODO - Use polyfilled WebGL2RenderingContext instead of ANGLE extension
    if (isInstanced && isIndexed) {
      extension.drawElementsInstancedANGLE(
        drawMode, vertexCount, indexType, offset, instanceCount
      );
    } else if (isInstanced) {
      extension.drawArraysInstancedANGLE(
        drawMode, offset, vertexCount, instanceCount
      );
    } else if (isIndexed) {
      gl.drawElements(drawMode, vertexCount, indexType, offset);
    } else {
      gl.drawArrays(drawMode, offset, vertexCount);
    }
  }

  /**
   * Attach a map of Buffers values to a program
   * Only attributes with names actually present in the linked program
   * will be updated. Other supplied buffers will be ignored.
   *
   * @param {Object} buffers - An object map with attribute names being keys
   *  and values are expected to be instances of Buffer.
   * @returns {Program} Returns itself for chaining.
   */
  /* eslint-disable max-statements */
  setBuffers(buffers, {clear = true, check = true, drawParams = {}} = {}) {
    if (Array.isArray(buffers)) {
      throw new Error('Program.setBuffers expects map of buffers');
    }

    if (clear) {
      this._filledLocations = {};
    }

    // indexing is autodetected - buffer with target gl.ELEMENT_ARRAY_BUFFER
    // index type is saved for drawElement calls
    drawParams.isInstanced = false;
    drawParams.isIndexed = false;
    drawParams.indexType = null;

    const {locations, elements} = this._sortBuffersByLocation(buffers);

    const {gl} = this;

    // Process locations in order
    for (let location = 0; location < locations.length; ++location) {
      const bufferName = locations[location];
      const buffer = buffers[bufferName];
      // DISABLE MISSING ATTRIBUTE
      if (!buffer) {
        VertexAttributes.disable(gl, location);
      } else {
        const divisor = buffer.layout.instanced ? 1 : 0;
        VertexAttributes.enable(gl, location);
        VertexAttributes.setBuffer({gl, location, buffer});
        VertexAttributes.setDivisor(gl, location, divisor);
        drawParams.isInstanced = buffer.layout.instanced > 0;
        this._filledLocations[bufferName] = true;
      }
    }

    // SET ELEMENTS ARRAY BUFFER
    if (elements) {
      const buffer = buffers[elements];
      buffer.bind();
      drawParams.isIndexed = true;
      drawParams.indexType = buffer.layout.type;
    }

    if (check) {
      this._checkBuffers();
    }

    return this;
  }
  /* eslint-enable max-statements */

  /*
   * @returns {Program} Returns itself for chaining.
   */
  unsetBuffers() {
    const length = this._attributeCount;
    for (let i = 1; i < length; ++i) {
      // VertexAttributes.setDivisor(gl, i, 0);
      VertexAttributes.disable(this.gl, i);
    }
    this.gl.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, null);
    return this;
  }

  /**
   * Apply a set of uniform values to a program
   * Only uniforms with names actually present in the linked program
   * will be updated.
   * other uniforms will be ignored
   *
   * @param {Object} uniformMap - An object with names being keys
   * @returns {Program} - returns itself for chaining.
   */
  /* eslint-disable max-depth */
  setUniforms(uniforms) {
    for (const uniformName in uniforms) {
      const uniform = uniforms[uniformName];
      const uniformSetter = this._uniformSetters[uniformName];
      if (uniformSetter) {
        if (uniform instanceof Texture) {
          if (uniformSetter.textureIndex === undefined) {
            uniformSetter.textureIndex = this._textureIndexCounter++;
          }
          // Bind texture to index, and set the uniform sampler to the index
          const texture = uniform;
          const {textureIndex} = uniformSetter;
          // console.debug('setting texture', textureIndex, texture);
          texture.bind(textureIndex);
          uniformSetter(textureIndex);
        } else {
          // Just set the value
          uniformSetter(uniform);
        }
      }
    }
    return this;
  }
  /* eslint-enable max-depth */

  /**
   * ATTRIBUTES API
   * (Locations are numeric indices)
   * @return {Number} count
   */
  getAttributeCount() {
    return this.getParameter(GL.ACTIVE_ATTRIBUTES);
  }

  /**
   * Returns location (index) of a name
   * @param {String} attributeName - name of an attribute
   *   (matches name in a linked shader)
   * @returns {Number} - // array of actual attribute names from shader linking
   */
  getAttributeLocation(attributeName) {
    return this.gl.getAttribLocation(this.handle, attributeName);
  }

  /**
   * Returns an object with info about attribute at index "location"/
   * @param {int} location - index of an attribute
   * @returns {WebGLActiveInfo} - info about an active attribute
   *   fields: {name, size, type}
   */
  getAttributeInfo(location) {
    return this.gl.getActiveAttrib(this.handle, location);
  }

  /**
   * UNIFORMS API
   * (Locations are numeric indices)
   * @return {Number} count
   */
  getUniformCount() {
    return this.getParameter(GL.ACTIVE_UNIFORMS);
  }

  /*
   * @returns {WebGLActiveInfo} - object with {name, size, type}
   */
  getUniformInfo(index) {
    return this.gl.getActiveUniform(this.handle, index);
  }

  /*
   * @returns {WebGLUniformLocation} - opaque object representing location
   * of uniform, used by setter methods
   */
  getUniformLocation(name) {
    return this.gl.getUniformLocation(this.handle, name);
  }

  getUniformValue(location) {
    return this.gl.getUniform(this.handle, location);
  }

  // WebGL2
  // Retrieves the assigned color number binding for the user-defined varying
  // out variable name for program. program must have previously been linked.
  getFragDataLocation(varyingName) {
    assertWebGL2Context(this.gl);
    return this.gl.getFragDataLocation(this.handle, varyingName);
  }

  // Return the value for the passed pname given the passed program.
  // The type returned is the natural type for the requested pname,
  // as given in the following table:
  getParameter(pname) {
    // Return default values for WebGL2 parameters under WebGL1
    if (!isWebGL2Context(this.gl)) {
      switch (pname) {
      case GL.ACTIVE_UNIFORMS: return 0;
      case GL.TRANSFORM_FEEDBACK_BUFFER_MODE: return GL.SEPARATE_ATTRIBS;
      case GL.TRANSFORM_FEEDBACK_VARYINGS: return 0;
      case GL.ACTIVE_UNIFORM_BLOCKS: return 0;
      default:
      }
    }
    return this.gl.getProgramParameter(this.handle, pname);
  }

  // @returns {WebGLShader[]} - array of attached WebGLShader objects
  getAttachedShaders() {
    return this.gl.getAttachedShaders(this.handle);
  }

  // PRIVATE METHODS

  _compileAndLink(vs, fs) {
    const {gl} = this;
    gl.attachShader(this.handle, this.vs.handle);
    gl.attachShader(this.handle, this.fs.handle);
    gl.linkProgram(this.handle);
    gl.validateProgram(this.handle);
    const linked = gl.getParameter(this.handle, GL.LINK_STATUS);
    if (!linked) {
      throw new Error(`Error linking ${gl.getProgramInfoLog(this.handle)}`);
    }
  }

  _checkBuffers() {
    for (const attributeName in this._attributeLocations) {
      if (!this._filledLocations[attributeName] && !this._warn[attributeName]) {
        const location = this._attributeLocations[attributeName];
        // throw new Error(`Program ${this.id}: ` +
        //   `Attribute ${location}:${attributeName} not supplied`);
        log.warn(0, `Program ${this.id}: ` +
          `Attribute ${location}:${attributeName} not supplied`);
        this._warn[attributeName] = true;
      }
    }
    return this;
  }

  _sortBuffersByLocation(buffers) {
    let elements = null;
    const locations = new Array(this._attributeCount);

    for (const bufferName in buffers) {
      const buffer = Buffer.makeFrom(this.gl, buffers[bufferName]);
      const location = this._attributeLocations[bufferName];
      if (location === undefined) {
        if (buffer.target === GL.ELEMENT_ARRAY_BUFFER && elements) {
          throw new Error(
            `${this._print(bufferName)} duplicate GL.ELEMENT_ARRAY_BUFFER`);
        } else if (buffer.target === GL.ELEMENT_ARRAY_BUFFER) {
          elements = bufferName;
        } else if (!this._warn[bufferName]) {
          log.warn(2, `${this._print(bufferName)} not used`);
          this._warn[bufferName] = true;
        }
      } else {
        if (buffer.target === GL.ELEMENT_ARRAY_BUFFER) {
          throw new Error(`${this._print(bufferName)}:${location} ` +
            'has both location and type gl.ELEMENT_ARRAY_BUFFER');
        }
        locations[location] = bufferName;
      }
    }
    return {locations, elements};
  }

  // Check that all active attributes are enabled
  _areAllAttributesEnabled() {
    const {gl} = this;
    const length = this._attributeCount;
    for (let i = 0; i < length; ++i) {
      if (!VertexAttributes.isEnabled(gl, i)) {
        return false;
      }
    }
    return true;
  }

  // determine attribute locations (maps attribute name to index)
  _getAttributeLocations() {
    const attributeLocations = {};
    const length = this.getAttributeCount();
    for (let location = 0; location < length; location++) {
      const name = this.getAttributeInfo(location).name;
      attributeLocations[name] = this.getAttributeLocation(name);
    }
    return attributeLocations;
  }

  // create uniform setters
  // Map of uniform names to setter functions
  _getUniformSetters() {
    const {gl} = this;
    const uniformSetters = {};
    const length = this.getUniformCount();
    for (let i = 0; i < length; i++) {
      const info = this.getUniformInfo(i);
      const parsedName = parseUniformName(info.name);
      const location = this.getUniformLocation(parsedName.name);
      uniformSetters[parsedName.name] =
        getUniformSetter(gl, location, info, parsedName.isArray);
    }
    return uniformSetters;
  }

  _print(bufferName) {
    return `Program ${this.id}: Attribute ${bufferName}`;
  }

  _createHandle() {
    this.handle = this.gl.createProgram();
    this._compileAndLink(this.vs, this.fs);

    // determine attribute locations (i.e. indices)
    this._attributeLocations = this._getAttributeLocations();
    this._attributeCount = this.getAttributeCount();
    this._warn = [];
    this._filledLocations = {};

    // prepare uniform setters
    this._uniformSetters = this._getUniformSetters();
    this._uniformCount = this.getUniformCount();
    this._textureIndexCounter = 0;
  }

  _deleteHandle() {
    this.gl.deleteProgram(this.handle);
  }

  _getOptionsFromHandle(handle) {
    const shaderHandles = this.gl.getAttachedShaders(handle);
    const opts = {};
    for (const shaderHandle of shaderHandles) {
      const type = this.gl.getShaderParameter(this.handle, GL.SHADER_TYPE);
      switch (type) {
      case GL.VERTEX_SHADER:
        opts.vs = new VertexShader({handle: shaderHandle});
        break;
      case GL.FRAGMENT_SHADER:
        opts.fs = new FragmentShader({handle: shaderHandle});
        break;
      default:
      }
    }
    return opts;
  }
}

// create uniform setters
// Map of uniform names to setter functions
export function getUniformDescriptors(gl, program) {
  const uniformDescriptors = {};
  const length = program.getUniformCount();
  for (let i = 0; i < length; i++) {
    const info = program.getUniformInfo(i);
    const location = program.getUniformLocation(info.name);
    const descriptor = getUniformSetter(gl, location, info);
    uniformDescriptors[descriptor.name] = descriptor;
  }
  return uniformDescriptors;
}

