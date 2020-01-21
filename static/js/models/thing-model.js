/**
 * Thing Model.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */
'use strict';

const API = require('../api');
const App = require('../app');
const Model = require('./model');
const Constants = require('../constants');
const Semaphore = require('./semaphore');
const CV = require('./cv');

class ThingModel extends Model {
  constructor(description, ws) {
    super();
    this.title = description.title;
    this.properties = {};
    this.events = [];
    this.connected = false;
    this.sequenceNumber = 0;
    this.semaphore = new Semaphore(1);
    this.cv = new CV();
    this.sessionId = Math.random();
    this.sequenceNumberUsed = false;

    // Parse base URL of Thing
    if (description.href) {
      this.href = new URL(description.href, App.ORIGIN);
      this.id = decodeURIComponent(this.href.pathname.split('/').pop());
    }

    // Parse events URL
    for (const link of description.links) {
      switch (link.rel) {
        case 'events':
          this.eventsHref = new URL(link.href, App.ORIGIN);
          break;
        case 'properties':
          this.propertiesHref = new URL(link.href, App.ORIGIN);
          break;
        default:
          break;
      }
    }

    // Parse properties
    this.propertyDescriptions = {};
    if (description.hasOwnProperty('properties')) {
      for (const propertyName in description.properties) {
        const property = description.properties[propertyName];
        this.propertyDescriptions[propertyName] = property;
      }
    }

    // Parse events
    this.eventDescriptions = {};
    if (description.hasOwnProperty('events')) {
      for (const eventName in description.events) {
        const event = description.events[eventName];
        this.eventDescriptions[eventName] = event;
      }
    }

    this.initWebSocket(ws);

    this.updateEvents();
    this.updateProperties();

    return this;
  }

  /**
   * Remove the thing.
   */
  removeThing() {
    return API.removeThing(this.id).then(() => {
      this.handleEvent(Constants.DELETE_THING, this.id);
      this.cleanup();
    });
  }

  /**
   * Update the thing.
   */
  updateThing(updates) {
    return API.updateThing(this.id, updates);
  }

  /**
   * Initialize websocket.
   */
  initWebSocket(globalWs) {
    if (!this.hasOwnProperty('href')) {
      return;
    }

    this.ws = globalWs;

    // After the websocket is open, add subscriptions for all events.
    this.ws.addEventListener('open', () => {
      if (Object.keys(this.eventDescriptions).length == 0) {
        return;
      }
      const msg = {
        id: this.id,
        messageType: 'addEventSubscription',
        data: {},
      };
      for (const name in this.eventDescriptions) {
        msg.data[name] = {};
      }
      this.ws.send(JSON.stringify(msg));
    });

    const onEvent = (event) => {
      const message = JSON.parse(event.data);
      if (message.hasOwnProperty('id') && message.id !== this.id) {
        return;
      }
      switch (message.messageType) {
        case 'propertyStatus':
          this.onPropertyStatus(message.data);
          break;
        case 'event':
          this.onEvent(message.data);
          break;
        case 'connected':
          this.onConnected(message.data);
          break;
        case 'error':
          // status 404 means that the Thing already removed.
          if (message.data.status === '404 Not Found') {
            console.log('Successfully removed Thing.');
            this.handleEvent(Constants.DELETE_THING, this.id);
            this.cleanup();
          }
          break;
      }
    };

    this.ws.addEventListener('message', onEvent);
  }

  subscribe(event, handler) {
    super.subscribe(event, handler);
    switch (event) {
      case Constants.EVENT_OCCURRED:
        break;
      case Constants.PROPERTY_STATUS:
        handler(this.properties);
        break;
      case Constants.DELETE_THING:
        break;
      case Constants.CONNECTED:
        handler(this.connected);
        break;
      default:
        console.warn(`ThingModel does not support event:${event}`);
        break;
    }
  }

  /**
   * Set value of the property.
   *
   * @param {string} name - name of the property
   * @param {*} value - value of the property
   * @return {Promise} which resolves to the property set.
   */
  async setProperty(name, value) {
    if (this.sequenceNumberUsed) {
      return;
    }

    await this.semaphore.acquire({blocking: true, timeout: 10000});
    this.sequenceNumberUsed = true;

    if (!this.propertyDescriptions.hasOwnProperty(name)) {
      return Promise.reject(`Unavailable property name ${name}`);
    }

    switch (this.propertyDescriptions[name].type) {
      case 'number':
        value = parseFloat(value);
        break;
      case 'integer':
        value = parseInt(value);
        break;
      case 'boolean':
        value = Boolean(value);
        break;
    }

    const property = this.propertyDescriptions[name];

    let href;
    for (const link of property.links) {
      if (!link.rel || link.rel === 'property') {
        href = link.href;
        break;
      }
    }

    // Protocol step 0: Acquire lock from gateway
    const acquire_gateway_lock_payload = {
      ['sequenceNumber'] : this.sequenceNumber,
      ['sessionId'] : this.sessionId,
      ['protocolStep'] : 0
    }
    
    API.putJson(href, acquire_gateway_lock_payload).then((json) => {
      //TODO:DELETE
      console.log('prot0'+json['returnSequenceNumber']);

      if (json['returnSequenceNumber'] != this.sequenceNumber) {
        console.error('Error in sequence number. Expected: ' + this.sequenceNumber + '\nRecieved: ' + json['returnSequenceNumber']);
      }
      this.cv.signal();
    }).catch((error) => {
      console.error(error);
      throw new Error(`Error trying to acquire gateway lock ${name}`);
    });
    await this.cv.wait(this.semaphore, {blocking: true, timeout: 10000});

    // Protocol step 1: Execute
    const payload = {
      [name]: value,
      ['sequenceNumber'] : this.sequenceNumber,
      ['sessionId'] : this.sessionId,
      ['protocolStep'] : 1
    };

    const res = API.putJson(href, payload).then((json) => {
      this.onPropertyStatus(json);
      if (json['returnSequenceNumber'] != this.sequenceNumber) {
        console.error('Error in sequence number. Expected: ' + this.sequenceNumber + '\nRecieved: ' + json['returnSequenceNumber']);
      }
      this.cv.signal();
    }).catch((error) => {
      console.error(error);
      throw new Error(`Error trying to set ${name}`);
    });
    await this.cv.wait(this.semaphore, {blocking: true, timeout: 10000});

    // Protocol step 2: Release Lock
    const release_gateway_lock_payload = {
      ['sequenceNumber'] : this.sequenceNumber,
      ['sessionId'] : this.sessionId,
      ['protocolStep'] : 2
    }
    
    API.putJson(href, release_gateway_lock_payload).then((json) => {
      //TODO:DELETE
      console.log('prot2'+json['returnSequenceNumber']);
      
      if (json['returnSequenceNumber'] != this.sequenceNumber) {
        console.error('Error in sequence number. Expected: ' + this.sequenceNumber + '\nRecieved: ' + json['returnSequenceNumber']);
      }
      this.cv.signal();
    }).catch((error) => {
      console.error(error);
      throw new Error(`Error trying to release gateway lock ${name}`);
    });
    await this.cv.wait(this.semaphore, {blocking: true, timeout: 10000});

    this.sequenceNumber = this.sequenceNumber + 1;
    this.sequenceNumberUsed = false;

    this.semaphore.release();
    return res;
  }

  /**
   * Update the Properties of Thing.
   */
  updateProperties() {
    let getPropertiesPromise;
    if (typeof this.propertiesHref === 'undefined') {
      const urls = Object.values(this.propertyDescriptions).map((v) => {
        for (const link of v.links) {
          if (!link.rel || link.rel === 'property') {
            return link.href;
          }
        }
      });
      const requests = urls.map((u) => API.getJson(u));
      getPropertiesPromise = Promise.all(requests).then((responses) => {
        let properties = {};
        responses.forEach((response) => {
          properties = Object.assign(properties, response);
        });
        return properties;
      });
    } else {
      getPropertiesPromise = API.getJson(this.propertiesHref);
    }

    getPropertiesPromise.then((properties) => {
      this.onPropertyStatus(properties);
    }).catch((error) => {
      console.error(`Error fetching ${this.title} status: ${error}`);
    });
  }

  /**
   * Handle a 'propertyStatus' message.
   * @param {Object} data Property data
   */
  onPropertyStatus(data) {
    const updatedProperties = {};
    for (const prop in data) {
      if (!this.propertyDescriptions.hasOwnProperty(prop)) {
        continue;
      }

      const value = data[prop];
      if (typeof value === 'undefined' || value === null) {
        continue;
      }

      this.properties[prop] = value;
      updatedProperties[prop] = value;
    }
    return this.handleEvent(Constants.PROPERTY_STATUS, updatedProperties);
  }

  /**
   * Get the list of existing events.
   */
  updateEvents() {
    if (typeof this.eventsHref === 'undefined') {
      return;
    }

    return API.getJson(this.eventsHref).then((events) => {
      this.events = events;
    }).catch((e) => {
      console.error(`Error fetching events: ${e}`);
    });
  }

  /**
   * Handle an 'event' message.
   * @param {Object} events Event data
   */
  onEvent(data) {
    const events = {};
    for (const event in data) {
      if (!this.eventDescriptions.hasOwnProperty(event)) {
        continue;
      }
      events[event] = data[event];
      this.events.push({[event]: data[event]});
    }
    return this.handleEvent(Constants.EVENT_OCCURRED, events);
  }

  /**
   * Handle a 'connected' message.
   *
   * @param {boolean} connected - Connected state
   */
  onConnected(connected) {
    this.connected = connected;

    if (connected) {
      this.updateProperties();
    }

    return this.handleEvent(Constants.CONNECTED, connected);
  }
}

module.exports = ThingModel;
