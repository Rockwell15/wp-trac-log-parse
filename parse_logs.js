/**
 * Parser for WordPress Trac Logs
 */

var $         = require( "cheerio" ),
	_         = require( "underscore" ),
	parseArgs = require( "minimist" ),
	async     = require( "async" ),
	request   = require( "request" ),
	md        = require('markdown-it')(),
	fs        = require('fs');


var logPath, tempHTML, logHTML, finalHTML, ticketHTML, date, testDescription,
	changesets = [],
	newMerges  = [],
	descriptions = [];


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

		// Condense merges for nextReleaseVersion
		if ( /Merge of \[[0-9]+\] to the [0-9.]+ branch/.test( description.text() ) ) {
			var newMerge = description.text().match(/Merge of (\[[0-9]+\]) to the 4.6 branch/i);

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

		testDescription = changeset['description'].replace( /(\d+\.\d+ branch)/, '' );
		if ( -1 < descriptions.indexOf( testDescription ) ) {
			continue;
		}
		descriptions.push( testDescription );

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
		
		// if ( changeset['related'].length ) {
		// 	getTicketComponent( ticketPath+changeset['related'][0], changesetCallback, changeset, 0 );

		// } else {
		// 	changesetCallback();

		// }

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

			// If there is no component assigned add this item to "Misc"
			if ( ! category.length ) {
				category = item['component'] = "Misc";

			} else if ( 'General' === category[0] && 1 < category.length ) { // If we can, add it to a more specific category than general
				for ( var i = 0; i < category.length; i++ ) {
					if ( 'General' !== category[ i ] ) {

						category = item['component'] = category[ i ];
						i = 999;

					}
				}
			}

			// If the component is still an object set it to the first string in it's array
			if ( 'object' === typeof category ) {
				category = item['component'] = category[0];
			}

			if ( ! categories[category] ) {
				categories[category] = [];
			}

			categories[ category ].push( item );
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

		if ( -1 < component.indexOf('Misc') ) {
			var newMergesLength = newMerges.length;
			changesetOutput += '* Updates for 4.6. Merge of ' + newMerges.slice( 0, newMergesLength-1 ).join(', ') + ' and ' + newMerges.slice( newMergesLength-1, newMergesLength ) + ' to the 4.6 branch.\n';
		}

		changesetOutput += "\n";
	});

	// Collect Props and sort them.
	props = _.uniq( props.sort( function ( a, b ) {
			return a.toLowerCase().localeCompare( b.toLowerCase() );
		}), true );

	propsOutput = "Thanks to " + "@" + _.without( props, _.last( props ) ).join( ", @" ) +
		", and @" + _.last( props ) + " for their contributions!";



	var $ticketHTML  = $.load( ticketHTML );

	var commits      = startRevision - stopRevision + 1;
	var contributors = propsOutput.split('@').length - 1;
	var created      = $ticketHTML('dt.newticket').length;
	var reopened     = $ticketHTML('dt.reopenedticket').length;
	var closed       = $ticketHTML('dt.closedticket').length;

	var header = '';
	header += 'Welcome back the latest issue of Week in Core, covering changes [' + stopRevision + '-' + startRevision + ']. Here are the highlights:\n';
	header += '* ' + commits + ' commits\n';
	header += '* ' + contributors + ' contributors\n';
	header += '* ' + created + ' tickets created\n';
	header += '* ' + reopened + ' tickets reopened\n';
	header += '* ' + closed + ' tickets closed\n\n';
	header += 'Ticket numbers based on trac [timeline](' + ticketPath + ') for the period above. The following is a summary of commits, organized by component.\n';
	header += '## Code Changes\n';



	// Output!
	var result = md.render( header + changesetOutput );
	finalHTML = result + '\n\n' + propsOutput;

	fs.writeFile("html.txt", result + '\n\n' + propsOutput, function(err) {
	    if(err) {
	        return console.log(err);
	    }

	    console.log("The file was saved!");
	});

	outputCallback();

}


// var args = parseArgs(process.argv.slice(2), {
// 		'alias': {
// 			'start': ['to'],
// 			'stop': ['from']
// 		},
// 		'default': {
// 			'limit': 400
// 		}
// 	}),
// 	startRevision      = parseInt( args['start'], 10 ),
// 	stopRevision       = parseInt( args['stop'], 10 ),
// 	date               = args['date'],
// 	revisionLimit      = 400,
// 	nextReleaseVersion = parseFloat( args['version'] );
// if ( isNaN(startRevision) || isNaN(stopRevision) || ! date ) {
// 	console.log( "Usage: node parse_logs.js --start=<start_revision> --stop=<revision_to_stop> --date=<latest_date_of_overview> [--limit=<total_revisions>]\n" );
// 	process.exit();
// }
// logPath    = "https://core.trac.wordpress.org/log?rev=" + startRevision + "&stop_rev=" + stopRevision + "&limit=" + revisionLimit + "&verbose=on";


// get past tuesday
now = new Date();
now.setDate( now.getDate() - ( 7 + now.getDay() - 2 ) % 7 );
date = encodeURIComponent( [ now.getMonth() + 1, now.getDate(), now.getFullYear().toString().substr(-2) ].join('/') );

changeTimeline = 'https://core.trac.wordpress.org/timeline?from=' + date + '&daysback=6&changeset=on';
ticketPath     = 'https://core.trac.wordpress.org/timeline?from=' + date + '&daysback=6&ticket=on';

async.series([
	// get changeset timeline, so we can auto grab start & stop revisions
	function( callback ) {
		console.log( "Building `logPath`" );
		request( changeTimeline, function( err, response, html ) {
			if ( ! err && response.statusCode == 200 ) {
				tempHTML = $.load( html )('.timeline dl dt');
				console.log($( tempHTML.find('dl dt')[0] ).text());
				startRevision = $( tempHTML[0] ).text().match(/\[(.+)\]/)[1];
				stopRevision  = $( tempHTML[ tempHTML.length - 1 ] ).text().match(/\[(.+)\]/)[1];
				logPath = "https://core.trac.wordpress.org/log?rev=" + startRevision
					+ "&stop_rev=" + stopRevision
					+ "&verbose=on";
				callback();
			} else {
				console.log( "Error Downloading.");
				return err;
			}
		});
	},
	// get ticket timeline, so we can auto grab stats highlights
	function( callback ) {
		console.log( "Downloading " + ticketPath );
		request( ticketPath, function( err, response, html ) {
			if ( !err && response.statusCode == 200 ) {
				ticketHTML = html;
				callback();
			} else {
				console.log( "Error Downloading.");
				return err;
			}
		});
	},
	// get changeset log
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
