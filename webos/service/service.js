// SPDX-License-Identifier: GPL-3.0-only
// ES5 for older LG service runtimes. webos-service is supplied by the TV.
var Service = require('webos-service');
var request = require('./transport').request;
var service = new Service('com.tvkdevelopment.plezy.catalog');
service.register('request', function (message) {
  request(message.payload, function (result) { message.respond(result); });
});
