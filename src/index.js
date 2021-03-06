var _ = require( "lodash" );
var defaultAccepts = [ "application/json" ];
var defaultMediaTypes = [ "application/json", "application/hal+json", "application/hal.v1+json" ];

var swaggerTools = require( "swagger-tools" );
var swaggerValidator = swaggerTools.specs.v2.validators[ "schema.json" ];

function processSchema( globalSchemas, schemaPart ) {
	if ( !_.isPlainObject( schemaPart ) ) {
		return schemaPart;
	}

	return _.mapValues( schemaPart, function( val ) {
		var foundSchema;
		if ( val && val.hasOwnProperty( "anyOf" ) && val.anyOf.length === 2 ) {
			var nullObj = _.findIndex( val.anyOf, { type: "null" } );
			if ( nullObj > -1 ) {
				val = val.anyOf[ nullObj === 0 ? 1 : 0 ];
				val[ "x-isnullable" ] = true;
			}
		}

		if ( val && val.hasOwnProperty( "$ref" ) && val.$ref[ 0 ] !== "#" ) {
			foundSchema = _.findKey( globalSchemas, { id: val.$ref } );
			if ( foundSchema ) {
				val.$ref = "#/definitions/" + foundSchema;
			}
		}

		if ( _.isPlainObject( val ) ) {
			return processSchema( globalSchemas, val );
		}

		if ( _.isArray( val ) ) {
			return _.map( val, processSchema.bind( null, globalSchemas ) );
		}

		return val;
	} );
}

function applySchemas( definitions, schemas ) {
	_.each( schemas, function( schema, key ) {
		_.extend( definitions, schema.definitions );
		definitions[ key ] = _.omit( schema, [ "id", "definitions", "$schema" ] );
	} );
}

var VERB_ORDER = {
	GET: 0,
	POST: 1,
	PUT: 2,
	PATCH: 3,
	DELETE: 4
};

function prepareCachedResponses( meta, hyped ) {
	var versions = {};

	Object.keys( hyped.fullOptionModels ).forEach( function( versionKey ) {
		var globalSchemas = _.cloneDeep( meta.schemas || {} );
		var paths = {};
		var response = _.merge( {
			swagger: "2.0",
			basePath: "/",
			info: {
				termsOfService: "",
				contact: {},
				license: {}
			}
		}, _.omit( meta, "schemas" ) );

		var links = hyped.fullOptionModels[ versionKey ]._links;
		var tags = [];
		var schemas = {};

		var resources = _.reduce( links, function( memo, value, key ) {
			var keyParts = key.split( ":" );
			var resource = keyParts[ 0 ];
			var action = keyParts[ 1 ];
			memo[ resource ] = memo[ resource ] || [];
			memo[ resource ].push( _.extend( { name: action }, value ) );
			return memo;
		}, {} );

		_.each( resources, function( actions, resource ) {
			var resourceDefinition = hyped.resources[ resource ];
			var resourceDocs = resourceDefinition.docs || {};
			var parent = resourceDefinition.parent;

			if ( !_.find( tags, { name: resource } ) && !parent && !_.isEmpty( resourceDocs ) ) {
				tags.push( {
					name: resource,
					description: resourceDocs.description || ""
				} );
			}

			if ( resourceDocs.schemas ) {
				_.each( resourceDocs.schemas, function( schema, key ) {
					schemas[ key ] = _.cloneDeep( schema );
				} );
			}

			actions.sort( function( a, b ) {
				var aLength = a.href.split( "/" ).length;
				var bLength = b.href.split( "/" ).length;
				var aVerb = VERB_ORDER[ a.method ];
				var bVerb = VERB_ORDER[ b.method ];

				if ( aLength === bLength ) {
					return aVerb - bVerb;
				}

				return aLength - bLength;
			} );

			actions.forEach( function( action ) {
				var actionDefinition = resourceDefinition.actions[ action.name ];
				var docs = actionDefinition.docs || {};

				if ( _.isEmpty( docs ) ) {
					return;
				}

				paths[ action.href ] = paths[ action.href ] || {};
				paths[ action.href ][ action.method.toLowerCase() ] = _.extend( {
					tags: [ parent ? parent : resource ],
					operationId: resource + ":" + action.name,
					description: "",
					summary: "",
					parameters: [],
					responses: {
						default: {
							description: "No documentation available"
						}
					},
					consumes: defaultAccepts,
					produces: defaultMediaTypes
				}, docs );
			} );
		} );

		response.tags = tags;
		response.paths = paths;

		var definitions = {};
		applySchemas( definitions, schemas );
		applySchemas( definitions, globalSchemas );
		response.definitions = processSchema( globalSchemas, definitions );

		swaggerValidator.options.breakOnFirstError = true;

		var valid = swaggerValidator.validate( response, "schema.json" );

		if ( !valid ) {
			console.error( swaggerValidator.lastReport.errors[ 0 ] ); // eslint-disable-line no-console
			process.exit( 1 ); // eslint-disable-line no-process-exit
		}

		versions[ versionKey ] = response;
	} );

	return versions;
}

var NOT_FOUND = 404;
var middleware = function( meta, hyped ) {
	var responses = prepareCachedResponses( meta, hyped );

	return function( req, res ) {
		if ( responses.hasOwnProperty( req.params.version ) ) {
			res.header( {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "X-Requested-With",
				"Access-Control-Allow-Methods": "OPTIONS"
			} );
			res.json( responses[ req.params.version ] );
		} else {
			res.status( NOT_FOUND ).json( { message: "Could not find swagger definition for " + req.params.version } );
		}
	};
};

module.exports = middleware;
