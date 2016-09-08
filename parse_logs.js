/**
 * Parser for WordPress Trac Logs
 */

var $         = require( "cheerio" ),
	_         = require( "underscore" ),
	parseArgs = require( "minimist" ),
	async     = require( "async" ),
	request   = require( "request" )
	fs        = require('fs'),
	md        = require('markdown-it')();

function buildChangesets( buildCallback ) {
	console.log( "Downloaded. Processing Changesets." );

	var logEntries = $.load( logHTML )( "tr.verbose" );

	// Each Changeset has two Rows. We Parse them both at once.
	for (var i = 0; i < logEntries.length; i += 2) {
		var changeset = {},
			props, description, related;

		if ( logEntries[i+1] == null ) {
			break;
		}

		description = $( logEntries[i+1] ).find( "td.log" );

		// Condense merges for specified version
		if ( /Merge of \[[0-9]+\] to the [0-9.]+ branch/.test( description.text() ) ) {
			var regexString = 'Merge of (\[[0-9]+\]) to the ' + args['branch'] + ' branch';
			var regex = new RegExp( regexString, 'i' );
			var newMerge = description.text().match( regex );

			if ( null !== newMerge ) {
				newMerges.push( newMerge[1] );
			}

			continue;
		}

		changeset['revision'] = $( logEntries[i] ).find( "td.rev" ).text().trim().replace( /@(.*)/, "[$1]" );
		changeset['author']   = $( logEntries[i] ).find( "td.author" ).text().trim();

		// Re-add `` for code segments.
		$(description).find( "tt" ).each( function() {
			$(this).replaceWith( "`" + $(this).text() + "`" );
		});

		// Store "Fixes" or "See" tickets.
		changeset['related'] = [];
		changeset['component'] = [];
		$(description).find( "a.ticket" ).each( function() {
			var ticket = $(this).text().trim().replace( /#(.*)/, "$1" );
			changeset['related'].push( ticket );
		});

		// Create base description
		changeset['description'] = description.text();

		// For now, get rid of Fixes and See notes. Should we annotate in summary?
		changeset['description'] = changeset['description'].replace( /[\n|, ]Fixes(.*)/i, '' );
		changeset['description'] = changeset['description'].replace( /\nSee(.*)/i, '' );

		// Extract Props
		var propsRegex = /\nProps(.*)./i;
		changeset['props'] = [];

		var props = changeset['description'].match( propsRegex );
		if ( props !== null ) {
			changeset['props'] = props[1].trim().split( /\s*,\s*/ );
		}

		// Remove Props
		changeset['description'] = changeset['description'].replace( propsRegex, '' );

		// Limit to 1 paragraph
		changeset['description'] = changeset['description'].replace( /\n\n(?:.|\n)*/, '' );
		changeset['description'] = changeset['description'].trim();

		changesets.push( changeset );
	}
	buildCallback();
}

function gatherComponents( gatherCallback ) {
	var ticketPath = "https://core.trac.wordpress.org/ticket/";

	async.each( changesets, function( changeset, changesetCallback ) {
		async.each( changeset['related'], function( ticket, relatedCallback ) {
			getTicketComponent( ticketPath+ticket, relatedCallback, changeset, 0 );
		}, function( err ) {
			if ( !err ) {
				// TODO: Pick best category for this changeset.
				changesetCallback();
			} else {
				console.log( "ERROR:" );
				console.dir( err );
			}
		});
	},
	function( err ) {
		if ( !err ) {
			gatherCallback();
			//buildOutput();
		} else {
			console.log( "ERROR:" );
			console.dir( err );
		}
	});
}

function getTicketComponent( url, relatedCallback, changeset, attempt ) {

	request( url, function( err, response, body ) {
		if ( !err && response.statusCode == 200 ) {
			var component = $.load( body )( "#h_component" ).next( "td" ).text().trim();
			changeset['component'].push( component );

			if ( 0 === changeset['description'].indexOf( component ) ) {
				changeset['description'] = changeset['description'].replace( component + ': ', '' ).charAt(0).toUpperCase() + changeset['description'].substr( component.length + 3 );
			}

			relatedCallback();
		} else if ( ! err && 503 == response.statusCode && 5 > attempt ) {
			setTimeout(function() {
				getTicketComponent( url, relatedCallback, changeset, attempt++ );
			}, 2500);
		} else {
			relatedCallback();
		}
	});

}

function buildOutput( outputCallback ) {
	// Reconstitute Log and Collect Props
	var propsOutput,
		changesetOutput = "",
		props = [],
		categories = {};

	async.map( changesets,
		function( item ) {
			category = item['component'];

			if ( ! category.length ) {
				category = item['component'] = "Misc";

			} else if ( 'General' === category[0] && 1 < category.length ) {
				for ( var i = 0; i < category.length; i++ ) {
					if ( 'General' !== category[ i ] ) {
						category = item['component'] = category[ i ];
						i = 999;
					}
				}
			}

			// If the component is still an array set it to the first string in it's array
			if ( 'object' === typeof category ) {
				category = item['component'] = category[0];
			}

			if ( ! categories[category] ) {
				categories[category] = [];
			}

			categories[item['component']].push( item );
		}
	);

	//---- Sort the categories alphabetically
	const sortedCategories = {};
	Object.keys( categories ).sort().forEach(function( key ) {
		sortedCategories[ key ] = categories[ key ];
	});

	_.each( sortedCategories, function( category, component ) {
		changesetOutput += "### " + component + "\n";
		_.each( category, function( changeset ) {

			changesetOutput += "* " +
				changeset['description'].trim() + " " +
				changeset['revision'] + " " +
				"#" + changeset['related'].join(', #') + "\n";

			// Make sure Committers get credit
			props.push( changeset['author'] );

			// Sometimes Committers write their own code.
			// When this happens, there are no additional props.
			if ( changeset['props'].length != 0 ) {
				props = props.concat( changeset['props'] );
			}

		});

		if ( -1 < component.indexOf('General') ) {
			var newMergesLength = newMerges.length;
			changesetOutput += '* Updates for ' + args['branch'] + '. Merge of ' + newMerges.slice( 0, newMergesLength-1 ).join(', ') + ' and ' + newMerges.slice( newMergesLength-1, newMergesLength ) + ' to the 4.6 branch.\n';
		}

		changesetOutput += "\n";
	});

	// Collect Props and sort them.
	props = _.uniq( props.sort( function ( a, b ) {
			return a.toLowerCase().localeCompare( b.toLowerCase() );
		}), true );

	propsOutput = "Thanks to " + "@" + _.without( props, _.last( props ) ).join( ", @" ) +
		", and @" + _.last( props ) + " for their contributions!";

	// Output!
	var changesetOutput = md.render( changesetOutput );

	if ( 'true' == args['print'] ) {
		fs.writeFile("weekly-update.html", changesetOutput + "\n\n" + propsOutput, function(err) {
			if(err) {
				return console.log(err);
			}

			console.log("The file was saved!");
		});
	}

	console.log( changesetOutput + "\n\n" + propsOutput );
	outputCallback();
}

var logPath, logHTML,
	changesets = [],
	newMerges = [],
	args = parseArgs(process.argv.slice(2), {
		'alias': {
			'start': ['to'],
			'stop': ['from']
		},
		'default': {
			'limit': 400
		}
	}),
	startRevision = parseInt(args['start'], 10),
	stopRevision = parseInt(args['stop'], 10),
	revisionLimit = parseInt(args['limit'], 10);

if ( isNaN(startRevision) || isNaN(stopRevision) ) {
	console.log( "Usage: node parse_logs.js --start=<start_revision> --stop=<revision_to_stop> [--limit=<total_revisions>]\n" );
	return;
}

logPath = "https://core.trac.wordpress.org/log?rev=" + startRevision + "&stop_rev=" + stopRevision + "&limit=" + revisionLimit + "&verbose=on";

async.series([
	function( logCallback ) {
		console.log( "Downloading " + logPath );
		request( logPath, function( err, response, html ) {
			if ( !err && response.statusCode == 200 ) {
				logHTML = html;
				logCallback();
			} else {
				console.log( "Error Downloading.");
				return err;
			}
		});
	},
	async.apply( buildChangesets ),
	async.apply( gatherComponents ), // Calls buildOutput() on Finish.
	async.apply( buildOutput )
]);
